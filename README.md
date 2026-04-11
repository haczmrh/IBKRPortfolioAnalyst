# IBKRPortfolioAnalyst

基于 Cloudflare Worker 的投资组合实时分析工具，支持通过 **IBKR Flex Query** 自动导入持仓。

## 功能特点

- **IBKR 一键导入**：通过 Flex Web Service Token 和 Query ID 自动导入全部持仓
- **自动识别资产类型**：正股 (STK) / 期权 (OPT) 自动分类
- **期权 Delta 自动填入**：从 IBKR 数据中提取期权 Delta
- **实时价格更新**：支持 Yahoo Finance 实时行情
- **D3.js 可视化**：交互式环形图，同一 Ticker 的正股与期权合并显示
- **本地数据持久化**：自动保存至浏览器 localStorage
- **图片导出**：一键导出分析图表为 PNG

## IBKR Flex Query 配置指南

### 1. 创建 Flex Query
1. 登录 [IBKR Client Portal](https://portal.interactivebrokers.com/)
2. 导航到 **Performance & Reports → Flex Queries**
3. 点击 **Create** 创建新的 Activity Flex Query
4. 在 **Sections** 中勾选 **Open Positions**
5. 确保包含以下字段：`Symbol`, `Asset Category`, `Position`, `Mark Price`, `Position Value`, `Delta`, `Description`
6. 输出格式选择 **XML**
7. 保存并记下 **Query ID**

### 2. 获取 Flex Token
1. 在 Flex Queries 页面找到 **Flex Web Service Configuration**
2. 启用服务并复制 **Current Token**

### 3. 使用导入功能
1. 打开部署后的网页
2. 点击「📥 导入 IBKR」按钮
3. 输入 Token 和 Query ID，点击「开始导入」
4. 勾选「记住凭证」可在下次自动填入

## 部署

### Cloudflare Dashboard 手动部署
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 创建一个新的 Worker
3. 将 `worker.js` 代码粘贴到编辑器
4. 保存并部署

### 通过 GitHub 自动部署
关联 GitHub 仓库后，每次 push 自动触发部署。
