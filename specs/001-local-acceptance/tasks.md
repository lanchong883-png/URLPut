# 执行任务 · URLPut 本机版验收

依据[规格](spec.md)、[实施计划](plan.md)和[验收运行指南](quickstart.md)。
在 `docs/requirements/local-acceptance.md` 下记录构建提交、Chrome 版本、
每项结果及证据。环境或站点依赖导致无法执行时，记录阻塞并保留待验收状态。

## 阶段 1 · 构建验收包

- [x] T001 按 `specs/001-local-acceptance/quickstart.md` 安装依赖、运行类型检查和测试，构建 Chrome 内测包并记录构建提交。

## 阶段 2 · 准备真实浏览器

- [x] T002 在 Chrome 加载 `apps/extension/.output/chrome-mv3`，确认 Service Worker 和工作台启动。若受浏览器策略限制，记录具体错误。
- [x] T003 关闭业务 API 和数据库，准备空数据目录与请求记录，按 `docs/requirements/local-acceptance.md` 建立验收基线。

## 阶段 3 · US1 本机管理批次（P1）

独立验收标准为三种来源均能导入并保存，重启后在对应站点回读与导出，业务 API 请求为零。

- [ ] T004 [US1] 在 `apps/extension/components/ImportWorkbench.tsx` 对应工作台创建测试站点，分别导入 CSV、TXT 和表格粘贴，记录每个批次的站点、行数和来源行。
- [ ] T005 [US1] 关闭并重开 Chrome，从工作台回读上述批次，比较 `apps/extension/lib/report.ts` 生成的 CSV 与来源行，核对本机路径的业务 API 请求数为零。

## 阶段 4 · US2 延续未完成工作（P1）

独立验收标准为移动、恢复和重新授权均可回读原记录，批次检查及批量回访各续跑一次，已保存条目重复执行数为零。

- [ ] T006 [US2] 按 `docs/本机版开发交接.md` 实际移动测试目录、重新绑定并核对新写入位置，再撤销和恢复目录权限，确认原批次可读写。
- [ ] T007 [US2] 按 `docs/本机版开发交接.md` 在空目录备份并恢复至另一空目录，核对批次、回执、台账及未完成队列，确认恢复后能继续执行。
- [ ] T008 [US2] 通过 `apps/extension/components/BatchChecks.tsx` 对应入口启动批次检查与分析，保存部分条目后关闭 Chrome；重启续跑并核对访问顺序、检查点、超时和限流失败记录。
- [ ] T009 [US2] 通过 `apps/extension/components/VerifiedLinks.tsx` 对应入口筛选并启动批量回访，保存部分结果后关闭 Chrome；重启续跑并核对已保存条目零重复、访问失败记录和上次结论。

## 阶段 5 · US3 管理手动投稿证据（P2）

独立验收标准为在授权测试站点完成一次人工提交，记录回执并在公开后核验目标链接。导出可追溯来源行，重复候选被拦截。

- [ ] T010 [US3] 确认测试站点授权，按 `docs/本机版开发交接.md` 在来源批次批准文案并开始一次手动投稿，由用户在平台提交。提交结果不明时先核对平台状态。
- [ ] T011 [US3] 在 `apps/extension/components/ImportWorkbench.tsx` 对应入口登记接收回执，核对来源行与待审核状态，并使用同站点另一批次验证重复批准被拦截。
- [ ] T012 [US3] 评论公开后，在 `apps/extension/components/VerifiedLinks.tsx` 对应入口核对评论与目标地址，导出并核对回执来源行和公开证据。仍在审核时记录待验收。

## 阶段 6 · 复核与收尾

- [ ] T013 汇总 `docs/requirements/local-acceptance.md` 中的结果，逐项核对 SC-001 至 SC-004，并记录证据或阻塞。
- [ ] T014 按 `specs/001-local-acceptance/plan.md` 处理可复现缺陷，定位最小修改范围并复验受影响路径。无复现缺陷时记录结果。

## 依赖与执行顺序

- T001 至 T003 依序执行。US1 的最小交付是通过 T004 至 T005。
- US2 可复用 US1 样本，也可独立构建批次和回访夹具。
  T006 至 T009 在共用 Chrome 配置和目录时依序执行。
- US3 可在独立测试目录中开展。T010 至 T012 依序执行，
  授权或外部审核等待期间可继续 US1 与 US2。
- 有独立数据副本和浏览器配置时，可分别验证目录移动和队列中断。
  共用扩展状态时依序执行，并集中写验收结果。
- T013 汇总首轮结果，T014 复验后更新对应结果。
