# 本机验收运行指南

准备 Node.js 24、允许加载解包扩展的桌面 Chrome 和空测试目录。
从项目根目录运行以下命令。

```powershell
npm ci
npm run check
npm test
npm run package:chrome
```

关闭业务 API 和数据库。在 `chrome://extensions` 加载
`apps/extension/.output/chrome-mv3`，按
[本机验收清单](../../docs/requirements/local-acceptance.md)
依次验证，并记录构建提交、Chrome 版本和各项结果。

业务服务请求应为零，重启后可导出原数据并从未完成位置继续。
备份恢复后可回读原记录。授权站点的公开证据关联到原批次来源行。
生产部署和旧服务迁移无需作为本轮验收的前置条件。
