# LLM 模型对比

本地全栈应用，用于同时对比最多 4 个大模型的回答，并把每次对比记录保存到本地。

## 启动

```bash
npm install
npm run dev
```

首次运行前请先复制一份 key 配置：

```bash
cp .env.example .env
```

默认地址：

- 前端：http://127.0.0.1:6663
- 后端：http://127.0.0.1:8787

## 模型配置

模型的 URL、模型名写在 `server/config/models.js`，API key 从项目根目录 `.env` 读取。首次接入包含：

- DeepSeek V4 Pro
- DeepSeek V4 Flash
- GLM-5.1
- GPT-5.5

真实 key 不要提交到仓库，仓库里保留的是 `.env.example` 示例文件。

思考方式现在跟随单个模型配置：DeepSeek 支持开关和 `high/max`，GLM-5.1 支持开关，GPT-5.5 按 OpenAI `reasoning_effort` 档位配置。

费用根据接口返回的 `usage` 和 `server/config/models.js` 中的 `pricing` 计算。DeepSeek / OpenAI / Z.AI 已填公开 USD 价格；如果控制台有专属折扣，只需要改同一文件里的 `pricing`。

## 记录

对比记录保存在 `data/conversations.json`。项目没有用户概念，所有记录共用同一个本地历史列表。

## 流式输出

页面使用 `POST /api/compare/stream` 读取 `text/event-stream`。发送后会立即展示对比卡片，后端并发请求各模型并通过 SSE 推送 `model_delta`、`model_done` 和 `record_done` 事件；全部完成后保存历史记录。
