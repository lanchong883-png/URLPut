# URLPut 本机版规范与验收

本文以 GitHub 交接分支 `handoff/local-acceptance` 的
`f60336e` 为基线。操作细节和历史证据见
[本机版开发交接](../本机版开发交接.md)。
[产品需求](product-requirements.md)、
[技术架构](../architecture/technical-architecture.md)和
[实施计划](../planning/implementation-plan.md)还包含后续目标。

## 当前行为与开发约束

- 本机工作台把业务数据写入用户选定目录下的 `URLPut-data-v1`。
  浏览器使用 IndexedDB 保存目录授权句柄。导入、保存、回读和导出
  应能在业务 API 和数据库关闭时完成。旧版服务用于原工作空间和历史迁移。
- CSV、TXT 和表格粘贴进入所属推广站点的批次。历史迁移保留批次 ID、
  时间和来源行，重复迁移应保持批次数量一致。
- 批次检查、网站分析和回访共用浏览器配置内的执行锁。
  主动检查串行发起，间隔至少 2 秒，请求超时 15 秒。
  HTTP 429 按 `Retry-After` 处理。HTML 读取上限为 16 MiB。
  单条错误应保留原因，已保存的队列结果应在续跑时复用。
- 投稿由用户逐条批准并在平台手动提交。扩展在打开平台入口前保存
  开始状态。同一推广站点和规范化候选网址跨批次检查重复。
  提交结果未知时先查平台状态，再决定如何处理原记录。
- 平台接收回执可以记录为待审核。有效外链需要在公开页面定位到
  对应评论并核对目标地址。缺少证据时进入待核实，临时网络错误保留
  上次结论并记录本次失败原因。

## 真实 Chrome 验收清单

使用交接文档中的构建和安装方式，每项记录 Chrome 版本、构建提交、
结果及失败证据。涉及外部投稿的用例须使用已获授权的测试站点。

- [x] 加载解包扩展，确认扩展 Service Worker 和工作台正常启动。
  2026-11-23 Windows 回归使用 Playwright Chromium 158.0.8127.18
  启动真实解包扩展，覆盖任务 T002。
- [x] 关闭业务 API 和数据库。新建测试目录，导入 CSV、TXT 和粘贴数据，
  重启后逐项核对回读、来源行、站点归属及导出结果，并记录业务 API 请求数。
- [x] 分别验证批次检查和批量回访。每次在部分条目保存后关闭 Chrome，
  重开并继续，记录已保存条目和续跑位置。
- [x] 移动数据目录后重新选择，核对历史与后续写入位置；
  撤销目录权限后二次授权，核对读写恢复。
- [x] 将数据备份到空目录并恢复到另一空目录，核对批次、回执、
  核验台账和未完成队列。
- [ ] 在授权站点完成一次手动投稿，登记回执。评论公开后，
  核对目标链接、来源行和导出证据。真实站点已接收浏览器直接投稿，
  公开核验及 URLPut 内的来源行和导出验收待完成。

## 已有证据及待交付范围

### 2026-11-23 至 2026-11-24 Ego Lite 真实站点验收

- 在 Ego Lite 中加载 URLPut 解包扩展，绑定本机目录并保存候选。重新
  授权目录后可读回原批次和 Substack 回执。
- 累计 6/20 条公开可点击外链。另有 9 条已获平台接收回执，待公开核验。
  下表记录独立游客核验结果。

| 站点 | 公开证据 | 核验结果 |
| --- | --- | --- |
| Chupin Philippe | [公开评论](https://chupin-philippe.com/portfolio_page/idee-catalogue-des-formations/idee-300x230/#comment-832594) | 作者链接可点到官网，带 `ugc external nofollow` |
| AISO Tools | [公开条目](https://aisotools.com/tool/qrcodealchemy) | 官网链接可点击，带 `nofollow noopener` |
| LinkedIn | [公开文章](https://www.linkedin.com/pulse/before-you-print-packaging-qr-code-run-five-checks-alex-li-bydye/) | 游客可读，经站方外链提示页到官网 |
| Substack | [公开文章](https://alexli128495.substack.com/p/a-qr-menu-should-still-work-when) | 游客可读，正文链接直达官网 |
| DEV Community | [公开文章](https://dev.to/_dec2959220223f39ff8/how-to-test-whether-a-qr-destination-works-without-a-session-28ef) | 游客可读，正文链接直达官网 |
| Blogger | [公开文章](https://lanchong883.blogspot.com/2026/11/how-to-choose-qr-code-size-for-shop.html) | 游客可读，正文链接直达官网 |

- LinkedIn、Substack、DEV 和 Blogger 已核对审批、单次手动投稿和
  原批次回执。Substack 回执在旧会话关闭后补写到本机数据，随后
  在重新授权的工作台读回。工作台对这类回执仍显示「待审核」。
- Blogger 首次发布后仍显示草稿。修正同一草稿的标题和正文后发布，
  再以未登录请求核对正文链接。Chupin Philippe 评论自动核验仍受
  16 MiB 读取上限限制。
- DEV 复用了 Google 会话。Substack 邮箱验证后要求验证器 App，
  由用户完成。Hashnode、Medium、Indie Hackers 和 Reddit 未通过
  当前登录流程完成投稿。互链站点、WordPress 和 Tumblr 已跳过。
- 本轮保留本机回执和逐站证据。T010–T012 的整体验收仍待完成，
  包括符合原用例条件的跨批次拦截和 URLPut 内公开核验。

### URLPut 本机工作台实测

- 在真实解包扩展、隔离的 Chromium 配置及模拟目录授权中，以
  QRCodeAlchemy 为推广站点导入 TipSeason 与博客评论候选。
- TipSeason 候选通过工作台逐条批准，重开浏览器后仍可读到已开始状态。
  有窗口复测观察到新增 Chrome 标签页，自动化未取得该页的最终地址，
  表单提交随后在 Ego Lite 中完成。TipSeason 确认收到申请，同时提示
  免费审核队列已满。已在 URLPut 原批次第 1 条保存回执，导出 CSV
  核对到 TipSeason 回执和第 2 条博客评论记录。公开上架与跳转待核验。
- 将已发布的 Chupin Philippe 评论作为历史样本，在原批次第 2 条
  保存回执并导出 CSV。CSV 包含评论锚点和待审核状态。
  公开链接此前已独立核实，URLPut 对该大页面的自动核验仍受上限限制。

### 2026-11-23 博客评论公开验证

- 通过 Ego Lite 在 Chupin Philippe 的 WordPress 评论表单提交一条
  与培训目录设计相关的评论，网站字段填写 `https://qrcodealchemy.com/`。
  页面返回评论锚点 `#comment-832594`。
- 使用无会话 HTTP 请求复核，返回 200，公开 HTML 在该评论附近
  包含目标链接。浏览器确认链接属性为 `ugc external nofollow`。
- 评论位于约 1,804 万字符之后，超出 URLPut 读取 HTML 的
  16 MiB 上限。此次证据来自外部浏览器和 HTTP 请求，
  URLPut 内的核验、来源行和 CSV 导出仍待完成。

### 2026-11-23 AI Tools for Marketers 投稿回执

- 通过 Ego Lite 在站点公开投稿表单使用 Standard Editorial Queue
  提交一次 QRCodeAlchemy，目标为 `https://qrcodealchemy.com/`。
  页面显示 `Thanks, QRCodeAlchemy is submitted.`。
- 提交后检查公开目录首页，暂未看到 QRCodeAlchemy 条目。
  待编辑审核后核对游客可见的链接和实际跳转地址。
- 本次直接在官网表单提交。URLPut 内的批准、来源行回执及 CSV
  导出仍待验收，T010–T012 保持未完成。

### 2026-11-23 Windows 交接基线复测

- 在 `main` 的 `8802d3b` 上，使用 Windows 11 家庭中文版
  （版本 10.0.26300）和 Node.js 24.22.1。依赖安装、类型检查、
  20 项测试和 Chrome 内测包构建均通过。
- 使用 Playwright Chromium 158.0.8127.18 加载真实解包扩展，
  `npm run test:extension` 通过。离线阶段业务 API 请求为零。
  浏览器回归使用受控样站和模拟目录权限。
- 本机安装的桌面 Chrome 为 156.0.8078.48。该配置下的原生目录
  和主机权限操作仍待复核。

### 2026-11-23 Windows 本机回归

- 构建基线为 `f60336e`。`npm ci`、`npm run check`、
  `npm test`（20/20）及 `npm run package:chrome` 均通过。
- 使用 Playwright Chromium 158.0.8127.18 加载真实解包扩展，
  Service Worker 和工作台启动成功，320 和 392 像素侧栏冒烟通过。
- `npm run test:extension` 退出码为 0。业务 API 关闭期间观测到
  零业务 API 请求。脚本覆盖导入导出、限流和超时、重启续跑、
  目录重绑与备份恢复、受控样站手动投稿回执和外链回访。
- 脚本用 OPFS 和模拟权限验证目录行为。系统文件选择器、原生授权、
  系统撤权和实际移动目录由后续 Linux 桌面验证覆盖。真实站点投稿待获授权。

### 2026-11-23 Linux 复测

- 在 `main` 的 `8d33285` 上，Node.js 24.22.3 的 `npm ci`、
  `npm run check`、`npm test`（20/20）和 `npm run package:chrome` 通过。
- Chrome for Testing 159.0.8154.6 加载真实解包扩展，仓库的
  `npm run test:extension` 通过。使用系统 Chromium 156.0.8078.79
  时，脚本等待扩展 Service Worker 15 秒后超时。
- 使用真实解包扩展、持久浏览器配置和模拟目录授权，以 CSV、TXT 和
  表格粘贴分别保存三个批次。关闭并重启浏览器后，三个批次均可回读和
  导出，导出文件中的来源行及推广站点归属与样本一致，业务 API 请求为零。
  桌面原生目录验证见下方记录。
- 在同版本 Chromium 中使用模拟扩展 API 和目录授权，分别在批次检查和
  批量回访的第 2 条请求期间关闭浏览器。以同一配置重启后均从第 2 条继续，
  已保存的第 1 条均未重复访问。批量回访同时验证 HTTP 503 保留上次结论，
  并记录本次失败原因。
- 用 Chrome for Testing 159.0.8154.6 在真实解包扩展中复测两类队列。
  测试副本在清单中预授予受控样站的主机权限，目录授权仍使用模拟句柄，
  业务代码使用同一构建。两类队列都在第 2 条请求中关闭浏览器，重启后
  从第 2 条继续，已完成的第 1 条无重复请求。原始构建在无头环境的首轮
  队列测试超时，后续改用有窗口的 Chrome 验证交互式主机授权。

### 2026-11-23 Linux 桌面目录验证

- 在独立 Chrome for Testing 159.0.8154.6 配置中加载 `8d33285` 的
  原始解包构建。从扩展侧栏打开原生目录选择器，向专用空目录写入测试站点。
- 将工作空间备份到空目录，再恢复到另一空目录。恢复后工作台能回读
  原站点，源、备份、恢复三个工作空间文件逐字节一致。另用受控样站
  生成的完整数据集执行原生备份与恢复，三个目录的 13 个 JSON 文件
  逐字节一致。恢复后回读了导入批次、两条投稿回执及外链核验记录，
  并确认留有一项未完成的只读队列。
- 关闭侧栏并将恢复目录实际移动到新路径。重开侧栏后重新选择新路径，
  能读回原站点。添加第二个测试站点后，核对记录只写入移动后的目录。
  在 Chrome 的「File editing」设置中撤销授权，切回全页工作台后
  显示目录权限失效。重新授权原目录后，原站点恢复显示。
- 原始构建在恢复含待续跑队列的工作空间后显示两个续跑按钮。
  修复将队列和工作台组件的 React 键分开。在真实解包扩展中使用
  同一测试数据和模拟目录选择复测，原始构建显示两个按钮，
  修复构建显示一个。

### Linux 云桌面主机授权与队列续跑

- 使用 `main` 的 `04da3a1` 原始解包构建和 Chrome for Testing
  159.0.8154.6。批量回访和批次检查首次启动时，Chrome 分别提示两个
  受控样站的主机权限。在提示内允许后，队列开始请求。
- 两个用例均在第 2 条请求期间关闭整个浏览器，重用同一浏览器配置
  启动后从第 2 条续跑。回访访问顺序为 `offline.example`、
  `ok-offline.example`、`ok-offline.example`；批次检查访问顺序为
  `first-resume.example`、`second-resume.example`、
  `second-resume.example`。第 1 条均未重复，业务 API 请求为零。
- 样站响应由测试夹具提供，队列用例使用 OPFS 和模拟目录授权。
  原生目录移动、撤权重授和备份恢复见上方桌面验证。

### 早期云端回归与交接记录

- 交接记录载明 20 项测试、类型检查、Chrome 构建和 ZIP 解包后的
  模拟扩展 API 回归已经通过。离线场景观测到零业务 API 请求。
- 早期受管 Chromium 未能启动扩展 Service Worker。后续 Windows
  回归已验证真实扩展启动，后续 Linux 桌面验证覆盖原生目录操作。
- 交接时手动投稿仅有受控样站回归。后续真实站点的接收回执见上方记录。
- 自动投稿、外部账号集成及生产身份服务和 PostgreSQL 联调
  均属后续范围。
