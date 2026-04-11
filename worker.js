// ============================================================
// IBKR 投资组合实时分析工具 — Cloudflare Worker (单文件)
// 支持 IBKR Flex Query 自动导入持仓
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const IBKR_BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- Backend: Yahoo Finance Proxy ----
async function handleQuote(request) {
  const url = new URL(request.url);
  const ticker = url.searchParams.get('ticker');

  if (!ticker) {
    return jsonResp({ error: '缺少 ticker 参数' }, 400);
  }

  try {
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const resp = await fetch(yahooUrl, { headers: { 'User-Agent': UA } });

    if (!resp.ok) return jsonResp({ error: `Yahoo Finance 返回 ${resp.status}` }, resp.status);

    const data = await resp.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return jsonResp({ error: '无法解析行情数据' }, 502);

    return jsonResp({
      ticker: meta.symbol,
      price: meta.regularMarketPrice,
      previousClose: meta.previousClose ?? meta.chartPreviousClose,
      currency: meta.currency,
      exchange: meta.exchangeName,
      shortName: meta.shortName || meta.longName || meta.symbol,
    });
  } catch (err) {
    return jsonResp({ error: err.message }, 500);
  }
}

// ---- Backend: IBKR Flex Query Import ----
async function handleIBKRImport(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ error: '无效的请求体' }, 400);
  }

  const { token, queryId } = body;
  if (!token || !queryId) {
    return jsonResp({ error: '缺少 token 或 queryId' }, 400);
  }

  try {
    // Step 1: SendRequest — 获取 ReferenceCode
    const sendUrl = `${IBKR_BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`;
    const sendResp = await fetch(sendUrl, { headers: { 'User-Agent': UA } });
    const sendXml = await sendResp.text();

    // 解析 ReferenceCode — 更灵活的匹配
    const refMatch = sendXml.match(/<ReferenceCode[^>]*>\s*(\w+)\s*<\/ReferenceCode>/i);
    if (!refMatch) {
      // 检查 Status 和 ErrorMessage
      const errMatch = sendXml.match(/<ErrorMessage[^>]*>([^<]+)<\/ErrorMessage>/i);
      const codeMatch = sendXml.match(/<ErrorCode[^>]*>([^<]+)<\/ErrorCode>/i);
      const statusMatch = sendXml.match(/<Status[^>]*>([^<]+)<\/Status>/i);
      let errMsg = '';
      if (errMatch) errMsg = errMatch[1];
      else if (statusMatch) errMsg = `Status: ${statusMatch[1]}`;
      else errMsg = '无法获取 ReferenceCode';
      // 返回前 500 字符的原始响应用于调试
      return jsonResp({
        error: `IBKR SendRequest 失败: ${errMsg}`,
        debug_response: sendXml.substring(0, 500),
        debug_code: codeMatch ? codeMatch[1] : null,
        http_status: sendResp.status,
      }, 502);
    }
    const referenceCode = refMatch[1];

    // Step 2: GetStatement — 轮询获取结果 (最多 8 次, 每次间隔 3 秒)
    let statementXml = '';
    let success = false;

    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 3000));
      }

      const getUrl = `${IBKR_BASE}/GetStatement?q=${referenceCode}&t=${encodeURIComponent(token)}&v=3`;
      const getResp = await fetch(getUrl, { headers: { 'User-Agent': UA } });
      statementXml = await getResp.text();

      // 检查是否仍在生成 (ErrorCode 1019 = still generating)
      if (statementXml.includes('1019') ||
          statementXml.toLowerCase().includes('being generated') ||
          statementXml.toLowerCase().includes('please try again')) {
        continue;
      }

      // 检查其他错误
      const errCodeMatch = statementXml.match(/<ErrorCode[^>]*>([^<]+)<\/ErrorCode>/i);
      if (errCodeMatch && errCodeMatch[1] !== '0') {
        const errMatch = statementXml.match(/<ErrorMessage[^>]*>([^<]+)<\/ErrorMessage>/i);
        return jsonResp({
          error: `IBKR 错误: ${errMatch ? errMatch[1] : '错误代码 ' + errCodeMatch[1]}`,
          debug_response: statementXml.substring(0, 500),
        }, 502);
      }

      success = true;
      break;
    }

    if (!success) {
      return jsonResp({ error: 'IBKR 报告生成超时（24秒），请稍后重试' }, 504);
    }

    // Step 3: 解析 OpenPosition 数据
    const positions = parseFlexPositions(statementXml);

    return jsonResp({
      positions,
      count: positions.length,
      raw_length: statementXml.length,
    });

  } catch (err) {
    return jsonResp({ error: `IBKR 请求异常: ${err.message}` }, 500);
  }
}

// 解析 Flex Query XML 中的 OpenPosition 节点
function parseFlexPositions(xml) {
  const positions = [];
  // 匹配所有 OpenPosition 自闭合标签或开闭标签
  const regex = /<OpenPosition\s+([^>]+)\/?>|<OpenPosition\s+([^>]+)>[\s\S]*?<\/OpenPosition>/g;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    const attrs = match[1] || match[2] || '';
    const pos = {};

    // 提取属性
    const attrRegex = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRegex.exec(attrs)) !== null) {
      pos[am[1]] = am[2];
    }

    // 解析数量 — 支持负值（空头仓位）
    const rawQty = pos.position || pos.quantity || pos.openQuantity || '0';
    const quantity = parseFloat(rawQty);
    if (isNaN(quantity) || quantity === 0) continue;

    const assetCategory = (pos.assetCategory || '').toUpperCase();
    const isOption = assetCategory === 'OPT';

    // 期权使用底层股票代码，价格设为 0（稍后通过 Yahoo Finance 获取正股价格）
    // 这样 等效市值 = 数量 × 正股价格 × Delta × 100 才有意义
    const ticker = isOption
      ? (pos.underlyingSymbol || pos.symbol || '')
      : (pos.symbol || '');

    positions.push({
      ticker,
      name: pos.description || pos.symbol || '',
      type: isOption ? 'option' : 'stock',
      qty: quantity,
      // 期权价格 = 0，需通过一键更新获取底层正股价格
      price: isOption ? 0 : parseFloat(pos.markPrice || pos.costBasisPrice || '0'),
      delta: isOption ? Math.abs(parseFloat(pos.delta || '0.8')) : 1.0,
      previousClose: isOption ? 0 : parseFloat(pos.closePrice || pos.priorClose || '0'),
      currency: pos.currency || 'USD',
      isShort: quantity < 0,
    });
  }

  return positions;
}

// JSON 响应辅助函数
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ---- Frontend: SPA HTML ----
function renderHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IBKR 投资组合实时分析工具</title>
<meta name="description" content="基于 Cloudflare Worker 的投资组合实时分析仪表盘，支持 IBKR Flex Query 自动导入。">
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"><\/script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
/* ---- Reset & Variables ---- */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg-primary: #0b0f1a;
  --bg-card: #111827;
  --bg-card-hover: #1a2234;
  --bg-input: #1e293b;
  --border-color: #1e293b;
  --border-focus: #6366f1;
  --text-primary: #f1f5f9;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent-indigo: #6366f1;
  --accent-indigo-light: #818cf8;
  --accent-emerald: #10b981;
  --accent-rose: #f43f5e;
  --accent-amber: #f59e0b;
  --accent-orange: #f97316;
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 4px 24px rgba(0,0,0,0.3);
  --transition: 0.2s cubic-bezier(.4,0,.2,1);
}

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.6;
  min-height: 100vh;
}

/* ---- Layout ---- */
.app-container {
  max-width: 1060px;
  margin: 0 auto;
  padding: 32px 20px 80px;
}

/* ---- Header ---- */
.app-header {
  text-align: center;
  margin-bottom: 40px;
  position: relative;
}
.app-header::before {
  content: '';
  position: absolute;
  top: -60px; left: 50%; transform: translateX(-50%);
  width: 400px; height: 400px;
  background: radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}
.app-header h1 {
  font-size: 2rem;
  font-weight: 800;
  background: linear-gradient(135deg, var(--accent-orange), var(--accent-indigo-light));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  position: relative;
  z-index: 1;
  letter-spacing: -0.02em;
}
.app-header p {
  color: var(--text-muted);
  font-size: 0.9rem;
  margin-top: 6px;
  position: relative;
  z-index: 1;
}

/* ---- Card ---- */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  padding: 24px;
  margin-bottom: 24px;
  box-shadow: var(--shadow);
  transition: border-color var(--transition);
}
.card:hover { border-color: #2d3a50; }
.card-title {
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 18px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
}
.card-title .icon {
  width: 28px; height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

/* ---- Buttons ---- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition);
  white-space: nowrap;
}
.btn:active { transform: scale(0.97); }
.btn-primary {
  background: linear-gradient(135deg, var(--accent-indigo), #4f46e5);
  color: #fff;
}
.btn-primary:hover { background: linear-gradient(135deg, var(--accent-indigo-light), var(--accent-indigo)); box-shadow: 0 0 20px rgba(99,102,241,0.3); }
.btn-success {
  background: linear-gradient(135deg, var(--accent-emerald), #059669);
  color: #fff;
}
.btn-success:hover { box-shadow: 0 0 20px rgba(16,185,129,0.3); }
.btn-danger {
  background: rgba(244,63,94,0.15);
  color: var(--accent-rose);
  border: 1px solid rgba(244,63,94,0.2);
}
.btn-danger:hover { background: rgba(244,63,94,0.25); }
.btn-ghost {
  background: var(--bg-input);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}
.btn-ghost:hover { background: var(--bg-card-hover); color: var(--text-primary); }
.btn-ibkr {
  background: linear-gradient(135deg, var(--accent-orange), #ea580c);
  color: #fff;
}
.btn-ibkr:hover { box-shadow: 0 0 20px rgba(249,115,22,0.3); }
.btn-sm { padding: 5px 10px; font-size: 0.75rem; border-radius: 6px; }
.btn-icon { width: 32px; height: 32px; padding: 0; border-radius: 8px; font-size: 16px; }

/* ---- Top Actions ---- */
.top-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

/* ---- Table ---- */
.table-wrap { overflow-x: auto; }
table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.82rem;
}
thead th {
  background: var(--bg-input);
  color: var(--text-muted);
  font-weight: 600;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
  position: sticky;
  top: 0;
  z-index: 1;
}
thead th:first-child { border-radius: var(--radius-sm) 0 0 0; }
thead th:last-child { border-radius: 0 var(--radius-sm) 0 0; }
tbody td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  vertical-align: middle;
}
tbody tr { transition: background var(--transition); }
tbody tr:hover { background: var(--bg-card-hover); }

/* ---- Inputs ---- */
input, select {
  font-family: inherit;
  font-size: 0.82rem;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 7px 10px;
  transition: border-color var(--transition), box-shadow var(--transition);
  width: 100%;
}
input:focus, select:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(99,102,241,0.15);
}
input[type="number"] { -moz-appearance: textfield; }
input::-webkit-outer-spin-button,
input::-webkit-inner-spin-button { -webkit-appearance: none; }
select { cursor: pointer; }

.input-narrow { max-width: 100px; }
.input-ticker { max-width: 120px; text-transform: uppercase; }

/* ---- Name cell ---- */
.name-cell {
  font-size: 0.78rem;
  color: var(--text-secondary);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- Summary Row ---- */
.summary-bar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 14px;
  margin-top: 18px;
}
.stat-card {
  background: var(--bg-input);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
}
.stat-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.stat-value {
  font-size: 1.35rem;
  font-weight: 800;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

/* ---- Chart ---- */
#chart-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 420px;
  position: relative;
}
#donut-chart { overflow: visible; }

.chart-tooltip {
  position: absolute;
  pointer-events: none;
  background: rgba(17,24,39,0.95);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 0.8rem;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 100;
  white-space: nowrap;
}
.chart-tooltip .tip-name { font-weight: 700; margin-bottom: 3px; }
.chart-tooltip .tip-value { color: var(--text-secondary); }

/* ---- Price badge ---- */
.price-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 20px;
  font-size: 0.72rem;
  font-weight: 600;
}
.price-badge.loading { background: rgba(245,158,11,0.15); color: var(--accent-amber); }
.price-badge.success { background: rgba(16,185,129,0.15); color: var(--accent-emerald); }
.price-badge.error { background: rgba(244,63,94,0.15); color: var(--accent-rose); }

/* ---- Misc ---- */
.fade-in { animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.pct-cell { font-variant-numeric: tabular-nums; font-weight: 600; }
.change-pos { color: var(--accent-emerald); }
.change-neg { color: var(--accent-rose); }

/* ---- Modal / Overlay ---- */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s;
}
.modal-overlay.active { opacity: 1; pointer-events: auto; }
.modal {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  padding: 28px;
  width: 90%;
  max-width: 440px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  transform: translateY(20px);
  transition: transform 0.25s;
}
.modal-overlay.active .modal { transform: translateY(0); }
.modal h2 {
  font-size: 1.1rem;
  font-weight: 700;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.modal label {
  display: block;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 4px;
  margin-top: 14px;
}
.modal label:first-of-type { margin-top: 0; }
.modal input[type="text"],
.modal input[type="password"] {
  width: 100%;
  margin-bottom: 2px;
}
.modal .modal-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
  justify-content: flex-end;
}
.modal .checkbox-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
  font-size: 0.78rem;
  color: var(--text-secondary);
}
.modal .checkbox-row input[type="checkbox"] {
  width: auto;
  accent-color: var(--accent-indigo);
}
.modal .import-status {
  margin-top: 14px;
  font-size: 0.8rem;
  padding: 8px 12px;
  border-radius: 6px;
  display: none;
}
.modal .import-status.show { display: block; }
.modal .import-status.loading { background: rgba(245,158,11,0.1); color: var(--accent-amber); }
.modal .import-status.success { background: rgba(16,185,129,0.1); color: var(--accent-emerald); }
.modal .import-status.error { background: rgba(244,63,94,0.1); color: var(--accent-rose); }

/* ---- Responsive ---- */
@media (max-width: 700px) {
  .app-container { padding: 20px 12px 60px; }
  .app-header h1 { font-size: 1.5rem; }
  table { font-size: 0.75rem; }
  thead th, tbody td { padding: 6px 6px; }
  .input-ticker { max-width: 80px; }
  .input-narrow { max-width: 70px; }
}
</style>
</head>
<body>

<div class="app-container">
  <!-- Header -->
  <header class="app-header">
    <h1>📊 IBKR 投资组合实时分析</h1>
    <p>Portfolio Real-time Analyzer · 支持 IBKR Flex Query 自动导入</p>
  </header>

  <!-- Data Entry Card -->
  <section class="card" id="data-card">
    <div class="card-title">
      <span class="icon" style="background:rgba(99,102,241,0.15);color:var(--accent-indigo);">📋</span>
      持仓录入
    </div>
    <div class="top-actions">
      <button class="btn btn-ibkr" onclick="openImportModal()" id="btn-ibkr-import">📥 导入 IBKR</button>
      <button class="btn btn-primary" onclick="addRow()" id="btn-add-row">＋ 添加资产</button>
      <button class="btn btn-success" onclick="fetchAllPrices()" id="btn-fetch-all">🔄 一键更新全部价格</button>
      <button class="btn btn-ghost" onclick="clearAll()" id="btn-clear">🗑 清空</button>
    </div>
    <div class="table-wrap">
      <table id="asset-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>名称</th>
            <th>类型</th>
            <th>数量</th>
            <th>价格 ($)</th>
            <th>Delta</th>
            <th>等效市值</th>
            <th>占比</th>
            <th>今日变动</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="asset-body"></tbody>
      </table>
    </div>
    <div class="summary-bar" id="summary-bar">
      <div class="stat-card">
        <div class="stat-label">总资产等效市值</div>
        <div class="stat-value" id="total-value">$0.00</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">今日总盈亏</div>
        <div class="stat-value" id="total-daily-change">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">持仓数量</div>
        <div class="stat-value" id="total-count">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">数据更新</div>
        <div class="stat-value" id="last-update" style="font-size:0.85rem;">—</div>
      </div>
    </div>
  </section>

  <!-- Chart Card -->
  <section class="card" id="chart-card">
    <div class="card-title" style="justify-content:space-between;">
      <span style="display:flex;align-items:center;gap:8px;">
        <span class="icon" style="background:rgba(16,185,129,0.15);color:var(--accent-emerald);">🍩</span>
        仓位分布图
      </span>
      <button class="btn btn-ghost btn-sm" onclick="exportImage()" id="btn-export">📷 保存为图片</button>
    </div>
    <div id="chart-container">
      <svg id="donut-chart"></svg>
    </div>
    <div class="chart-tooltip" id="tooltip"></div>
  </section>
</div>

<!-- IBKR Import Modal -->
<div class="modal-overlay" id="ibkr-modal">
  <div class="modal">
    <h2>📥 导入 IBKR 持仓</h2>
    <label for="ibkr-token">Flex Web Service Token</label>
    <input type="password" id="ibkr-token" placeholder="粘贴你的 Flex Token">
    <label for="ibkr-query-id">Flex Query ID</label>
    <input type="text" id="ibkr-query-id" placeholder="例如: 123456">
    <div class="checkbox-row">
      <input type="checkbox" id="ibkr-remember" checked>
      <span>记住凭证（仅保存在本地浏览器）</span>
    </div>
    <div class="import-status" id="import-status"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeImportModal()">取消</button>
      <button class="btn btn-ibkr" onclick="doIBKRImport()" id="btn-do-import">开始导入</button>
    </div>
  </div>
</div>

<script>
// ============ State ============
let assets = [];
let rowId = 0;

const COLORS = [
  '#6366f1','#10b981','#f59e0b','#f43f5e','#8b5cf6',
  '#06b6d4','#ec4899','#14b8a6','#f97316','#a78bfa',
  '#22d3ee','#fb923c','#e879f9','#34d399','#fbbf24',
  '#818cf8','#2dd4bf','#fb7185','#a3e635','#c084fc',
];

// ============ Helpers ============
function fmt(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}
function fmtChange(n) {
  const sign = n >= 0 ? '+' : '';
  return sign + n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}
function pct(n) { return (n * 100).toFixed(2) + '%'; }
function truncate(s, max) { return s.length > max ? s.slice(0, max - 1) + '…' : s; }

function save() {
  const data = assets.map(a => ({
    ticker: a.ticker, name: a.name, type: a.type,
    qty: a.qty, price: a.price, delta: a.delta,
    previousClose: a.previousClose,
  }));
  localStorage.setItem('ibkr_portfolio_v1', JSON.stringify(data));
}

function load() {
  try {
    const raw = localStorage.getItem('ibkr_portfolio_v1');
    if (!raw) return;
    const data = JSON.parse(raw);
    data.forEach(d => {
      addRow();
      const a = assets[assets.length - 1];
      a.ticker = d.ticker || '';
      a.name = d.name || '';
      a.type = d.type || 'stock';
      a.qty = d.qty || 0;
      a.price = d.price || 0;
      a.delta = d.delta ?? (d.type === 'option' ? 0.8 : 1.0);
      a.previousClose = d.previousClose || 0;
      syncRowToDOM(a);
    });
    recalc();
  } catch(e) { console.error('Load failed', e); }
}

// ============ IBKR Import Modal ============
function openImportModal() {
  // 恢复已存凭证
  const saved = localStorage.getItem('ibkr_credentials');
  if (saved) {
    try {
      const c = JSON.parse(saved);
      document.getElementById('ibkr-token').value = c.token || '';
      document.getElementById('ibkr-query-id').value = c.queryId || '';
    } catch {}
  }
  const status = document.getElementById('import-status');
  status.className = 'import-status';
  status.textContent = '';
  document.getElementById('ibkr-modal').classList.add('active');
}

function closeImportModal() {
  document.getElementById('ibkr-modal').classList.remove('active');
}

async function doIBKRImport() {
  const token = document.getElementById('ibkr-token').value.trim();
  const queryId = document.getElementById('ibkr-query-id').value.trim();
  const remember = document.getElementById('ibkr-remember').checked;

  if (!token || !queryId) {
    showImportStatus('请填写 Token 和 Query ID', 'error');
    return;
  }

  // 保存凭证
  if (remember) {
    localStorage.setItem('ibkr_credentials', JSON.stringify({ token, queryId }));
  } else {
    localStorage.removeItem('ibkr_credentials');
  }

  const btn = document.getElementById('btn-do-import');
  btn.disabled = true;
  btn.textContent = '⏳ 导入中...';
  showImportStatus('正在连接 IBKR Flex Web Service...', 'loading');

  try {
    const resp = await fetch('/api/ibkr/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, queryId }),
    });
    const data = await resp.json();

    if (data.error) {
      let msg = data.error;
      if (data.debug_response) {
        console.log('IBKR debug response:', data.debug_response);
        msg += '\\n\\n[调试] 原始响应: ' + data.debug_response.substring(0, 200);
      }
      throw new Error(msg);
    }
    if (!data.positions || data.positions.length === 0) {
      showImportStatus('未找到持仓数据，请检查 Flex Query 配置是否包含 Open Positions', 'error');
      btn.disabled = false;
      btn.textContent = '开始导入';
      return;
    }

    // 清空现有数据并导入
    assets = [];
    document.getElementById('asset-body').innerHTML = '';

    data.positions.forEach(p => {
      addRow();
      const a = assets[assets.length - 1];
      a.ticker = p.ticker || '';
      a.name = p.name || '';
      a.type = p.type || 'stock';
      a.qty = p.qty || 0;
      a.price = p.price || 0;
      a.delta = p.delta ?? 1.0;
      a.previousClose = p.previousClose || 0;
      syncRowToDOM(a);
    });

    recalc();
    save();

    showImportStatus('✓ 成功导入 ' + data.positions.length + ' 条持仓记录，正在更新实时价格...', 'success');

    // 关闭弹窗并自动获取全部实时价格（特别是期权的底层正股价格）
    setTimeout(async () => {
      closeImportModal();
      await fetchAllPrices();
    }, 1500);

  } catch (e) {
    showImportStatus('导入失败: ' + e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = '开始导入';
}

function showImportStatus(msg, type) {
  const el = document.getElementById('import-status');
  el.className = 'import-status show ' + type;
  el.textContent = msg;
}

// ============ Row Management ============
function addRow() {
  const id = ++rowId;
  const asset = { id, ticker: '', name: '', type: 'stock', qty: 0, price: 0, delta: 1.0, previousClose: 0 };
  assets.push(asset);

  const tbody = document.getElementById('asset-body');
  const tr = document.createElement('tr');
  tr.id = 'row-' + id;
  tr.className = 'fade-in';
  tr.innerHTML = \`
    <td><input class="input-ticker" id="tick-\${id}" placeholder="AAPL" oninput="upd(\${id},'ticker',this.value)"></td>
    <td class="name-cell" id="name-\${id}" title="">—</td>
    <td>
      <select id="type-\${id}" onchange="upd(\${id},'type',this.value); toggleDelta(\${id})">
        <option value="stock">正股</option>
        <option value="option">期权LEAPS</option>
      </select>
    </td>
    <td><input type="number" class="input-narrow" id="qty-\${id}" value="0" min="0" oninput="upd(\${id},'qty',+this.value)"></td>
    <td style="position:relative;">
      <input type="number" class="input-narrow" id="price-\${id}" value="0" step="0.01" min="0" oninput="upd(\${id},'price',+this.value)">
      <span class="price-badge" id="badge-\${id}" style="display:none;position:absolute;top:-8px;right:-6px;"></span>
    </td>
    <td><input type="number" class="input-narrow" id="delta-\${id}" value="1.0" step="0.01" min="0" max="1" disabled oninput="upd(\${id},'delta',+this.value)"></td>
    <td class="pct-cell" id="mktval-\${id}" style="white-space:nowrap;">$0.00</td>
    <td class="pct-cell" id="pct-\${id}">0.00%</td>
    <td class="pct-cell" id="chg-\${id}" style="white-space:nowrap;">—</td>
    <td style="white-space:nowrap;">
      <button class="btn btn-ghost btn-sm" onclick="fetchPrice(\${id})" title="获取价格" id="btn-fetch-\${id}">📡</button>
      <button class="btn btn-danger btn-sm btn-icon" onclick="removeRow(\${id})" title="删除" id="btn-del-\${id}">✕</button>
    </td>
  \`;
  tbody.appendChild(tr);
}

function removeRow(id) {
  assets = assets.filter(a => a.id !== id);
  const tr = document.getElementById('row-' + id);
  if (tr) {
    tr.style.opacity = '0';
    tr.style.transform = 'translateX(20px)';
    tr.style.transition = '0.25s';
    setTimeout(() => { tr.remove(); recalc(); }, 250);
  }
  save();
}

function clearAll() {
  if (!confirm('确定要清空所有持仓数据吗？')) return;
  assets = [];
  document.getElementById('asset-body').innerHTML = '';
  recalc();
  save();
}

function upd(id, key, val) {
  const a = assets.find(x => x.id === id);
  if (a) { a[key] = val; recalc(); save(); }
}

function toggleDelta(id) {
  const a = assets.find(x => x.id === id);
  const el = document.getElementById('delta-' + id);
  if (!a || !el) return;
  if (a.type === 'option') {
    el.disabled = false;
    a.delta = 0.8;
    el.value = '0.8';
  } else {
    el.disabled = true;
    a.delta = 1.0;
    el.value = '1.0';
  }
  recalc();
  save();
}

function syncRowToDOM(a) {
  const id = a.id;
  const el = (s) => document.getElementById(s + '-' + id);
  if (el('tick')) el('tick').value = a.ticker;
  if (el('name')) {
    el('name').textContent = a.name || '—';
    el('name').title = a.name || '';
  }
  if (el('type')) el('type').value = a.type;
  if (el('qty')) el('qty').value = a.qty;
  if (el('price')) el('price').value = a.price;
  if (el('delta')) {
    el('delta').value = a.delta;
    el('delta').disabled = a.type !== 'option';
  }
}

// ============ Calculations ============
function calcMktVal(a) {
  const multiplier = a.type === 'option' ? 100 : 1;
  return a.qty * a.price * a.delta * multiplier;
}

function calcDailyChange(a) {
  if (!a.previousClose || a.previousClose === 0) return 0;
  const multiplier = a.type === 'option' ? 100 : 1;
  return (a.price - a.previousClose) * a.delta * a.qty * multiplier;
}

function recalc() {
  let total = 0;
  let totalDailyChange = 0;
  assets.forEach(a => { total += calcMktVal(a); });

  assets.forEach(a => {
    const mv = calcMktVal(a);
    const dc = calcDailyChange(a);
    totalDailyChange += dc;

    const el_mv = document.getElementById('mktval-' + a.id);
    const el_pct = document.getElementById('pct-' + a.id);
    const el_chg = document.getElementById('chg-' + a.id);
    if (el_mv) el_mv.textContent = fmt(mv);
    if (el_pct) el_pct.textContent = total > 0 ? pct(mv / total) : '0.00%';
    if (el_chg) {
      if (a.previousClose && a.previousClose > 0 && a.qty > 0) {
        el_chg.textContent = fmtChange(dc);
        el_chg.className = 'pct-cell ' + (dc >= 0 ? 'change-pos' : 'change-neg');
      } else {
        el_chg.textContent = '—';
        el_chg.className = 'pct-cell';
      }
    }
  });

  document.getElementById('total-value').textContent = fmt(total);
  document.getElementById('total-count').textContent = assets.length;

  const elDC = document.getElementById('total-daily-change');
  const hasPrevClose = assets.some(a => a.previousClose > 0 && a.qty > 0);
  if (hasPrevClose) {
    elDC.textContent = fmtChange(totalDailyChange);
    elDC.className = 'stat-value ' + (totalDailyChange >= 0 ? 'change-pos' : 'change-neg');
  } else {
    elDC.textContent = '—';
    elDC.className = 'stat-value';
  }

  renderChart();
}

// ============ Price Fetching ============
async function fetchPrice(id) {
  const a = assets.find(x => x.id === id);
  if (!a || !a.ticker) return;

  const badge = document.getElementById('badge-' + id);
  badge.style.display = 'inline-flex';
  badge.className = 'price-badge loading';
  badge.textContent = '⏳';

  try {
    const resp = await fetch('/api/quote?ticker=' + encodeURIComponent(a.ticker.trim()));
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    a.price = data.price;
    a.previousClose = data.previousClose || 0;
    if (data.shortName) {
      a.name = data.shortName;
      const nameEl = document.getElementById('name-' + id);
      if (nameEl) {
        nameEl.textContent = data.shortName;
        nameEl.title = data.shortName;
      }
    }
    document.getElementById('price-' + id).value = data.price;
    badge.className = 'price-badge success';
    badge.textContent = '✓';
    recalc();
    save();
  } catch (e) {
    badge.className = 'price-badge error';
    badge.textContent = '✕';
    console.error('Fetch price error:', e);
  }

  setTimeout(() => { badge.style.display = 'none'; }, 3000);
}

async function fetchAllPrices() {
  const btn = document.getElementById('btn-fetch-all');
  btn.disabled = true;
  btn.textContent = '⏳ 更新中...';

  const promises = assets
    .filter(a => a.ticker.trim())
    .map(a => fetchPrice(a.id));
  await Promise.allSettled(promises);

  const now = new Date();
  document.getElementById('last-update').textContent =
    now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  btn.disabled = false;
  btn.textContent = '🔄 一键更新全部价格';
}

// ============ D3.js Donut Chart with Leader-Line Labels ============
function renderChart() {
  const container = document.getElementById('chart-container');
  const containerW = container.clientWidth || 700;
  const svgWidth = Math.min(containerW, 740);
  const svgHeight = Math.max(480, svgWidth * 0.65);
  const radius = Math.min(svgWidth * 0.22, svgHeight * 0.32);
  const innerRadius = radius * 0.55;

  // 合并同一 Ticker 的正股和期权，并按市值降序排列
  const merged = {};
  assets.forEach(a => {
    const mv = calcMktVal(a);
    if (mv <= 0) return;
    const key = a.ticker.trim().toUpperCase() || ('_unnamed_' + a.id);
    if (!merged[key]) {
      merged[key] = { name: a.name || a.ticker || ('资产' + a.id), value: 0, ticker: key };
    }
    merged[key].value += mv;
    if (a.name && a.name.length > (merged[key].name || '').length) {
      merged[key].name = a.name;
    }
  });

  const chartData = Object.values(merged)
    .sort((a, b) => b.value - a.value)
    .map((d, i) => ({
      name: d.name,
      ticker: d.ticker,
      value: d.value,
      color: COLORS[i % COLORS.length],
    }));

  const svg = d3.select('#donut-chart')
    .attr('width', svgWidth)
    .attr('height', svgHeight);

  svg.selectAll('*').remove();

  if (chartData.length === 0) {
    svg.append('text')
      .attr('x', svgWidth / 2).attr('y', svgHeight / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#475569')
      .attr('font-size', '14px')
      .text('暂无数据 — 请添加持仓');
    return;
  }

  const total = d3.sum(chartData, d => d.value);
  const cx = svgWidth / 2;
  const cy = svgHeight / 2;

  const g = svg.append('g')
    .attr('transform', \`translate(\${cx},\${cy})\`);

  const pie = d3.pie().value(d => d.value).sort(null).padAngle(0.02);
  const arc = d3.arc().innerRadius(innerRadius).outerRadius(radius).cornerRadius(4);
  const arcHover = d3.arc().innerRadius(innerRadius - 2).outerRadius(radius + 6).cornerRadius(4);
  const outerArc = d3.arc().innerRadius(radius * 1.2).outerRadius(radius * 1.2);

  const pieData = pie(chartData);
  const midAngle = d => d.startAngle + (d.endAngle - d.startAngle) / 2;

  const getEdgePoint = (d) => {
    const a = midAngle(d);
    return [Math.sin(a) * radius, -Math.cos(a) * radius];
  };

  const tooltip = document.getElementById('tooltip');

  // ---- Draw arc slices ----
  const arcs = g.selectAll('path.slice')
    .data(pieData)
    .join('path')
    .attr('class', 'slice')
    .attr('fill', d => d.data.color)
    .attr('stroke', 'var(--bg-card)')
    .attr('stroke-width', 2)
    .style('cursor', 'pointer')
    .on('mouseenter', function(event, d) {
      d3.select(this).transition().duration(150).attr('d', arcHover);
      tooltip.style.opacity = '1';
      tooltip.innerHTML = \`
        <div class="tip-name" style="color:\${d.data.color}">\${d.data.name}</div>
        <div class="tip-value">\${fmt(d.data.value)} · \${pct(d.data.value / total)}</div>
      \`;
    })
    .on('mousemove', function(event) {
      const rect = document.getElementById('chart-card').getBoundingClientRect();
      tooltip.style.left = (event.clientX - rect.left + 12) + 'px';
      tooltip.style.top = (event.clientY - rect.top - 10) + 'px';
    })
    .on('mouseleave', function() {
      d3.select(this).transition().duration(150).attr('d', arc);
      tooltip.style.opacity = '0';
    });

  // Animate slices in
  arcs.transition()
    .duration(700)
    .ease(d3.easeCubicOut)
    .attrTween('d', function(d) {
      const i = d3.interpolate({ startAngle: d.startAngle, endAngle: d.startAngle }, d);
      return t => arc(i(t));
    });

  // ---- Compute label positions with anti-overlap ----
  const labelArmLen = radius * 0.6;
  const minLabelGap = 32;

  const labels = pieData.map(d => {
    const mid = midAngle(d);
    const outerPt = outerArc.centroid(d);
    const edgePt = getEdgePoint(d);
    const isRight = mid < Math.PI;
    const xEnd = (radius + labelArmLen) * (isRight ? 1 : -1);
    return {
      d,
      mid,
      isRight,
      edgePt,
      outerPt,
      x: xEnd,
      y: outerPt[1],
      anchor: isRight ? 'start' : 'end',
    };
  });

  function resolveOverlap(side) {
    const items = labels.filter(l => l.isRight === side).sort((a, b) => a.y - b.y);
    if (items.length <= 1) return;

    const maxY = cy - 20;
    const minY = -cy + 20;

    for (let iter = 0; iter < 20; iter++) {
      let moved = false;
      for (let i = 1; i < items.length; i++) {
        const gap = items[i].y - items[i - 1].y;
        if (gap < minLabelGap) {
          const push = (minLabelGap - gap) / 2;
          items[i - 1].y -= push;
          items[i].y += push;
          moved = true;
        }
      }
      if (items[0].y < minY) {
        const shift = minY - items[0].y;
        items.forEach(l => l.y += shift);
      }
      if (items[items.length - 1].y > maxY) {
        const shift = items[items.length - 1].y - maxY;
        items.forEach(l => l.y -= shift);
      }
      if (!moved) break;
    }
  }
  resolveOverlap(true);
  resolveOverlap(false);

  // ---- Draw leader lines ----
  g.selectAll('polyline.label-line')
    .data(labels)
    .join('polyline')
    .attr('class', 'label-line')
    .attr('fill', 'none')
    .attr('stroke', d => d.d.data.color)
    .attr('stroke-width', 1.2)
    .attr('opacity', 0.5)
    .attr('points', d => {
      const elbowX = (radius * 1.15) * (d.isRight ? 1 : -1);
      const elbowPt = [elbowX, d.y];
      const labelPt = [d.x, d.y];
      return [d.edgePt, elbowPt, labelPt].map(p => p.join(',')).join(' ');
    });

  g.selectAll('circle.label-dot')
    .data(labels)
    .join('circle')
    .attr('class', 'label-dot')
    .attr('cx', d => d.edgePt[0])
    .attr('cy', d => d.edgePt[1])
    .attr('r', 2.5)
    .attr('fill', d => d.d.data.color);

  g.selectAll('text.pie-label')
    .data(labels)
    .join('text')
    .attr('class', 'pie-label')
    .attr('x', d => d.x + (d.isRight ? 6 : -6))
    .attr('y', d => d.y - 4)
    .attr('text-anchor', d => d.anchor)
    .attr('dominant-baseline', 'central')
    .attr('fill', d => d.d.data.color)
    .attr('font-size', '12px')
    .attr('font-weight', '700')
    .text(d => truncate(d.d.data.ticker || d.d.data.name, 14));

  g.selectAll('text.pie-pct')
    .data(labels)
    .join('text')
    .attr('class', 'pie-pct')
    .attr('x', d => d.x + (d.isRight ? 6 : -6))
    .attr('y', d => d.y + 12)
    .attr('text-anchor', d => d.anchor)
    .attr('dominant-baseline', 'central')
    .attr('fill', 'var(--text-muted)')
    .attr('font-size', '10px')
    .attr('font-weight', '500')
    .text(d => pct(d.d.data.value / total));

  // ---- Center label ----
  g.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', '-0.15em')
    .attr('fill', 'var(--text-muted)')
    .attr('font-size', '11px')
    .attr('font-weight', '600')
    .text('总资产');
  g.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', '1.2em')
    .attr('fill', 'var(--text-primary)')
    .attr('font-size', '16px')
    .attr('font-weight', '800')
    .text(fmt(total));
}

// ============ Export to Image ============
async function exportImage() {
  const btn = document.getElementById('btn-export');
  btn.disabled = true;
  btn.textContent = '⏳ 生成中...';
  try {
    const el = document.getElementById('chart-card');
    const canvas = await html2canvas(el, {
      backgroundColor: '#111827',
      scale: 2,
      useCORS: true,
    });
    const link = document.createElement('a');
    link.download = 'portfolio-chart-' + new Date().toISOString().slice(0,10) + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (e) {
    alert('导出失败: ' + e.message);
  }
  btn.disabled = false;
  btn.textContent = '📷 保存为图片';
}

// ============ Init ============
load();
if (assets.length === 0) { addRow(); }
window.addEventListener('resize', () => renderChart());
// 点击 modal 外部关闭
document.getElementById('ibkr-modal').addEventListener('click', function(e) {
  if (e.target === this) closeImportModal();
});
<\/script>
</body>
</html>`;
}

// ---- Router ----
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // API routes
    if (url.pathname === '/api/quote') {
      return handleQuote(request);
    }
    if (url.pathname === '/api/ibkr/import' && request.method === 'POST') {
      return handleIBKRImport(request);
    }

    // SPA
    return new Response(renderHTML(), {
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });
  },
};
