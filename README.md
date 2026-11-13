# 一念 · 想法笔记

按《想法记录与 AI 讨论 PWA 产品需求文档 V1.0》建立的首轮可运行全栈实现，版本 **0.2.0**。

记录灵感 → 围绕单条想法讨论 → 选择性采纳整理 → 推进行动。界面为简体中文，适配桌面和 360px 起的手机屏幕。没有语音、文件上传、联网搜索或社区功能。

> 当前是开发与内测基础，不是已完成商业验收的产品。默认使用明确标识的本地验证码和演示 AI；微信支付代码已接入，但尚无商户账号和真实配置，购买入口保持关闭。开通步骤见 [微信支付指南](docs/wechat-pay.md)。商业版差距见 [实现范围](docs/implementation.md)。

已部署到 <https://zzhao.cc.cd/idea-notes/>，线上采用账号密码登录。运维与部署配置见 [服务器部署说明](docs/deployment.md)。

## 快速启动

需要 **Node.js 24+**（当前使用内置 `node:sqlite`，运行时会显示实验性 API 提示）。

```powershell
cd E:\workspace\idea-notes
npm install
Copy-Item .env.example .env  # 仅首次执行；不要覆盖已有密钥配置
npm run dev
```

- 开发页面：<http://localhost:5173>
- API：<http://127.0.0.1:3001/api/health>
- 数据：`data/ideas.sqlite`，SQLite WAL 模式。重启不丢失已保存数据。
- 首次登录可输入自己的测试邮箱；点击“获取验证码”后，开发环境在页面显示验证码。无需注册或固定密码。
- 登录 `admin@example.com` 可查看开发版管理概览；允许的管理员邮箱在 `.env` 中配置。默认管理员仅适用于本地开发。
- 访客可以先写草稿，登录后明确确认才导入。演示内容不是个人数据，不会预先写入你的数据库。

## 构建与 PWA 预览

```powershell
npm run build
npm start
```

打开 <http://localhost:3001>。`start` 同时提供构建后的前端与 API；测试 PWA 时使用此方式。开发模式不注册 Service Worker，避免旧缓存干扰热更新。`dev` 和 `start` 共用 API 端口，请只运行一套；如已有 API 在运行，可单独执行 `npm run dev:web`。

构建脚本会根据产物生成独立版本的静态缓存，并预缓存 JS、CSS 与图标。首次成功联网加载后，可以离线重新打开应用及编辑本地草稿。API、对话和订单不会进入 Service Worker 缓存。浏览器的安装入口因平台而异，正式部署必须使用 HTTPS。

## 已实现的主要能力

- 邮箱验证码、协议确认、HttpOnly 会话、退出撤销、重新验证邮箱后注销。
- 想法新建、自动保存、手动保存、Unicode 字数校验、标签、状态、收藏、归档、组合搜索、30 条分页、回收站与恢复。
- IndexedDB 账号隔离草稿，800ms 本地暂存、2s 自动保存；最近 20 条离线阅读缓存。服务端版本冲突保留双方内容，支持比较、合并、另存副本。
- 每个想法独立对话、快捷问题预填、渐进显示回复、停止、手动重试、刷新后恢复任务状态。
- 明确标识的演示 AI；服务端 OpenAI 兼容 Chat Completions 流式适配器。密钥不进入浏览器。
- 发送前确认额度上限；数据库事务预占、单账号最多一个运行任务、请求幂等、按实际用量结算与释放。服务重启时释放遗留预占。
- 待采纳 AI 整理、旧内容比较、选项确认、候选行动选择、重复采纳去重、生成版本校验、手动整理与历史恢复。
- 行动添加、编辑、完成、重新打开与删除；每条最多 20 个未完成行动。
- 单条 Markdown、全量 ZIP + JSON，可选择包含对话或回收站。
- 微信支付 API v3 Native 扫码与可选 H5；订单价格快照、回调验签解密、查单、关闭订单、手动续费、权益发放、整笔退款与支持请求。未配置商户时明确显示尚未开通。
- 管理概览、AI 全局暂停开关和审计。管理员默认看不到想法正文、消息原文或模型密钥。

## 接入真实服务

复制 `.env.example` 后按需要配置，所有密钥仅由 API 进程读取。

### 账号密码

设置 `AUTH_MODE=password`，支持账号注册、登录、修改密码与密码确认注销。密码至少 12 个字符，使用随机盐 scrypt 哈希；登录有账号/IP 限流。`ADMIN_EMAILS` 在此模式下填写管理员账号名，需通过 `scripts/create-account.ts` 从标准输入初始化，不能通过公开注册抢占。当前没有邮箱找回密码。

### 真实邮件

设置 `AUTH_MODE=smtp` 和 `SMTP_HOST/PORT/SECURE/USER/PASS/FROM`。验证码有效 10 分钟、同邮箱发送间隔至少 60 秒、每小时最多 5 次、连续验证错误 5 次失效。

### 真实模型

设置 `AI_MODE=openai`、`AI_BASE_URL`、`AI_API_KEY`、`AI_QUICK_MODEL`、`AI_DEEP_MODEL`、`AI_PROVIDER_NAME`、`AI_DATA_POLICY_URL`。服务端会要求配置完整。Base URL 应包含供应商的 API 根路径，例如 `https://api.example.com/v1`。

供应商需支持 Chat Completions SSE、`max_tokens`、`stream_options.include_usage`；整理需要 `response_format: { type: "json_object" }`。不同供应商的 reasoning tokens、输出上限和 JSON 支持需单独核对。

当前本机 `.env` 已按用户要求接入 `https://api.kbsfdxc.com/codex/v1`，快速与深度模式均配置为 `gpt-6-astra`。密钥仅保存在已忽略的 `.env` 中，示例配置仍默认演示模式。该接口为第三方服务；本地数据流说明见 `/ai-data.html`，服务商正式数据政策尚未核实。实际联调结果见 [验证记录](docs/verification.md)。

免费账号只开放快速模式。服务端确认微信支付并激活付费周期后才开放深度模式，前端返回参数不能开通权益。

本版本额度是联调配置，不是正式报价。未知用量立即由平台承担，不追扣；正式版可扩展为最多 15 分钟的供应商对账流程。

### 微信支付

按 [商户开通与配置指南](docs/wechat-pay.md) 申请 Native/H5 权限，配置商户证书私钥、微信支付公钥、APIv3 密钥、HTTPS 回调和正式价格。默认 `PAYMENT_ENABLED=false`，无开发环境“模拟付款成功”接口，测试仅使用隔离的模拟供应商。真实支付需要商户开通后的实单验收。

### 生产配置保护

`NODE_ENV=production` 强制要求账号密码或 SMTP 登录及 HTTPS `APP_ORIGIN`。这只是最低启动保护，不代表已经具备商业上线条件。微信真实商户联调、管理员强认证、每日支付账单对账、数据库/备份加密、监控与恢复演练等仍须补齐。部署细节与风险见 [实现范围](docs/implementation.md)。

## 检查与测试

```powershell
npm run build                    # TypeScript 严格检查与产物构建
npm test                         # 内存数据库 API / AI 适配器测试
npx playwright install chromium  # 首次安装浏览器
npm run test:e2e                  # 独立端口 5174/3101 + work/e2e.sqlite
node scripts/check-pwa.mjs        # 先启动构建预览，默认检查 127.0.0.1:3001
npm run format
```

E2E 与业务数据隔离，测试截图写入 `work/`，追踪记录写入 `test-results/`。PWA 检查使用临时浏览器上下文，不在业务数据库创建账号或想法。

## 代码结构

```text
src/                  React 界面、草稿与账号缓存、PWA 更新提示
  App.tsx             工作区、导航、检索、访客草稿与账号切换
  Editor.tsx          原始记录、版本同步、讨论、整理与行动
  Pages.tsx           套餐额度、设置、管理概览
server/
  app.ts              账号、想法、额度、导出、管理 API
  db.ts               数据结构、事务与索引
  domain.ts           字段规则、版本、自然月额度、Markdown
  ai.ts               服务端流式模型适配、取消、结算、恢复
  payments/           微信 API v3、账单与订阅周期、幂等结算
public/               Manifest、Service Worker、图标、协议草案
scripts/              构建缓存版本、图标生成、PWA 验证
tests/                API、模拟供应商、浏览器端到端测试
docs/requirements.md  用户提供的原始需求副本
docs/implementation.md 当前交付边界、技术取舍和后续工作
```

数据库当前迁移版本为 3，使用 `schema_migrations` 记录。后续修改结构应追加迁移，不直接删除用户的数据库。`.env`、数据库、测试输出与依赖目录均已加入 `.gitignore`。
