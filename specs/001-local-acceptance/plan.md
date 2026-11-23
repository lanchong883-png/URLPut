# 实施计划 · URLPut 本机版验收

**Git 分支** `handoff/local-acceptance`

**功能规格** [spec.md](spec.md)

**日期** 2026-11-23

## 摘要

用真实 Chrome 验证现有内测包的离线工作流、目录权限、
中断续跑及经授权的手动投稿流程。仅对验收复现的缺陷确定修复范围。

## 技术背景

现有实现使用 Node.js 24、TypeScript、React、WXT 和 Chrome MV3。
本机数据以 JSON 保存，IndexedDB 保存目录句柄，Web Locks 协调同一
浏览器配置下的执行。旧版 API 只在历史迁移用例按需启动。

## 章程检查

- 范围以 SC-001 至 SC-004 为准，先验收、再定位缺陷。
- 复用构建、回归脚本和工作台。修复若涉及存量数据，则先验证读回和恢复。
- 真实安装和权限验收单独记录；投稿只使用获授权测试站点。
- 设计复核后仍符合章程。需要调整界面时，验证受影响操作和窗口尺寸。

## 项目结构

### 本规格文档

- [规格](spec.md)
- [规格质量检查](checklists/requirements.md)
- [决策记录](research.md)
- [数据模型](data-model.md)
- [工作台行为约定](contracts/workbench.md)
- [验收运行指南](quickstart.md)

### 预期涉及的源码

首轮记录验收证据。按缺陷定位到 `apps/extension/entrypoints/`、
`apps/extension/components/` 或 `apps/extension/lib/`。
受影响的受控场景复用 `scripts/extension-smoke.mjs`。

## 验收顺序与依赖

1. 确认真实 Chrome 允许加载解包扩展并可授权系统目录。
2. 关闭业务服务，验收导入、导出、备份恢复及重启续跑。
3. 使用获授权测试站点验收逐条手动投稿、回执和公开核验。
   审核时间由站点决定，等待公开时将该项记录为待验收。
4. 对复现缺陷确认最小修复范围，复测对应成功标准。

完成本计划后，依章程等待用户确认，再进入 Tasks。
