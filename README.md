# URLPut

URLPut 是用于管理外链候选的 Chrome MV3 扩展。本机工作台支持
CSV、TXT 和表格粘贴，可在用户选择的目录中保存批次、分析结果、
投稿回执和核验台账。

## 本机运行与验收

需要 Node.js 24 和允许加载解包扩展的 Chrome。

```powershell
npm ci
npm run package:chrome
```

在 `chrome://extensions` 打开开发者模式，加载
`apps/extension/.output/chrome-mv3`。点击扩展图标进入工作台，
选择一个空测试目录。保持业务 API 和数据库关闭，按
[本机版规范和验收清单](docs/requirements/local-acceptance.md)操作。
构建包位置和目录恢复说明见[本机版开发交接](docs/本机版开发交接.md)。

## 开发验证

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

开发旧版服务工作空间或复测历史迁移时，可运行
`npm run dev:api -- --local`。API 监听 `127.0.0.1:4310`，
PGlite 数据位于 `.data/postgres`。该模式信任本机，用于单用户开发。

Fastify API 支持 PostgreSQL 与 Supabase 签名访问令牌。部署时设置服务端 `DATABASE_URL`、`SUPABASE_URL` 和 `EXTENSION_ORIGIN`（例如对应固定扩展 ID 的 `chrome-extension://…`），并省略 `--local`。数据表按 `apps/api/migrations/` 中的 SQL 初始化。工作空间、推广站点和成员关系目前由管理员初始化，成员 `subject` 使用 Supabase 用户 UUID。

扩展构建读取 `VITE_API_URL`、`VITE_SUPABASE_URL` 和 `VITE_SUPABASE_PUBLIC_KEY`，其中后者必须是可发布的客户端公钥。Supabase 邮件模板使用验证码 `{{ .Token }}`，管理员先创建用户。生产身份服务和 Postgres 部署仍需在目标环境联调。

## 外链知识库 API

以下路径以 `/api/workspaces/:workspaceId` 为前缀，要求工作空间成员身份。

| 方法与路径 | 用途 |
| --- | --- |
| `POST /form-templates` | 保存已验证表单的字段映射，返回模板版本。 |
| `POST /form-templates/lookup` | 用页面 URL、入口类型、语言及表单摘要匹配模板，未命中时返回 `template: null`。 |
| `POST /link-catalog/observations` | 回传外链 URL、检查时间 `observedAt`、状态 `active` 或 `inactive` 和可选原因。 |
| `GET /link-catalog` | 分页读取最近 30 天内确认可用的外链。 |
| `GET /link-catalog/recheck` | 分页读取至少 7 天没有新检查结果的外链。 |

读取清单支持 `limit` 和 `offset`。清单通过检查回传更新，定时执行器尚待接入。

[产品需求](docs/requirements/product-requirements.md) · [技术架构](docs/architecture/technical-architecture.md)

Spec Kit 项目原则见[项目章程](.specify/memory/constitution.md)。
本机验收范围与后续工作见[功能规格](specs/001-local-acceptance/spec.md)
和[实施计划](specs/001-local-acceptance/plan.md)。
