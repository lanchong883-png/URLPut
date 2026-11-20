# URLPut

URLPut 是用于管理外链候选的 Chrome MV3 扩展。第一批实现覆盖 CSV 和表格粘贴、列映射、预览、确认和逐行台账。扩展内也可以配置及测试 OpenAI 兼容的本地或自建模型。

## 本地运行

需要 Node.js 24 和近期版本的 Chrome 或 Chromium。

```sh
npm ci
npm run dev:api -- --local
npm run dev:extension
```

本地 API 绑定在 `127.0.0.1:4310`，用 PGlite 在 `.data/postgres` 保存数据并提供示例工作空间。该模式信任本机，用于单用户开发。

也可执行 `npm run build`，然后在 `chrome://extensions` 打开开发者模式并加载 `apps/extension/.output/chrome-mv3`。点击扩展图标打开侧边栏，再进入工作台。

```sh
npm run check
npm test
npm run build
```

浏览器冒烟测试使用独立临时数据库和模拟模型服务。先停掉已占用 4310 端口的本地 API，再执行以下命令。也可以设置 `CHROMIUM_PATH` 使用已安装的 Chromium。

```sh
npx playwright install chromium
npm run build
npm run test:extension
```

没有解包扩展权限的环境可设置 `URLPUT_WEB_SMOKE=1`，用模拟扩展 API 验证页面、导入接口和模型协议。

## AI 模型

在工作台的 **AI 设置** 选择「本地模型」或「自建模型服务」。填入 OpenAI Chat Completions 的 API 基础地址，例如 `http://127.0.0.1:11434/v1` 或 `https://models.example.com/v1`。填写模型在服务端注册的完整名称，若服务要求鉴权则填写密钥。远程地址使用 HTTPS。本机 HTTP 支持 localhost、127.0.0.1 和 ::1。

「测试连接」会请求对应主机权限，并向配置服务发送固定测试消息。「保存设置」按服务类型保留地址、模型和两个开关，密钥只保存在当前浏览器会话中。AI 分析和文案开关将在对应功能接入后生效。自建服务目前需要实现 OpenAI 兼容的 `POST <基础地址>/chat/completions`。

## PostgreSQL 与认证接线

Fastify API 支持 PostgreSQL 与 Supabase 签名访问令牌。部署时设置服务端 `DATABASE_URL`、`SUPABASE_URL` 和 `EXTENSION_ORIGIN`（例如对应固定扩展 ID 的 `chrome-extension://…`），并省略 `--local`。数据表按 `apps/api/migrations/001-initial.sql` 初始化。工作空间、推广站点和成员关系目前由管理员初始化，成员 `subject` 使用 Supabase 用户 UUID。

扩展构建读取 `VITE_API_URL`、`VITE_SUPABASE_URL` 和 `VITE_SUPABASE_PUBLIC_KEY`，其中后者必须是可发布的客户端公钥。Supabase 邮件模板使用验证码 `{{ .Token }}`，管理员先创建用户。生产身份服务和 Postgres 部署仍需在目标环境联调。

[产品需求](docs/requirements/product-requirements.md) · [技术架构](docs/architecture/technical-architecture.md)
