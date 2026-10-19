# 市场版 3.2.17 同步记录

同步日期：2026-10-19。目标仓库：`notesynchelper/obsidian-notehelper-v2`。仅在本地修改和提交，不推送、不创建 Release、不修改版本提醒端点或部署。

## 基点与边界

- fork 基点：`0d7e2d6`，3.2.14。
- 主项目对应基点：`5d0cf7e`，3.2.14。
- 主项目检查时 HEAD：`0af85d6`，manifest 仍为 3.2.17。
- 本轮已发版代码边界：`83ea0ad`（3.2.17 的版本提交）。此后的未发版产品改动不纳入。
- 本地实施分支：`sync/market-3.2.17`。

开工时的未提交工作共 56 个文件（包含未跟踪目录内的实际文件），已逐一备份至 `/tmp/market-sync-20261019-original`。经 Git blob 与差异对照，确定它们是 `670455a` 网络韧性部分的手工移植，包含市场版审核适配。构建、Node 18 全量单测 140 suites / 1803 tests、官方 ESLint 均通过后，原样记录为 `7e6f87e`。

## 主项目提交处置

| 提交 | 本轮处置 |
|---|---|
| `017ad57` | 苹果地图前后对比截图工具，无产品变更；保留在主项目 harness，不复制历史证据 |
| `cb828bd` | 大附件超时、失败任务持久续传；产品实现已在旧工作中，补齐附件重启续传回归测试 |
| `232b11d` | 大附件请求上限 90 分钟，已在旧工作中 |
| `80a45ae` | 同步独立邮件配置、路由、模板与 HTML 附件支持；裁掉 Templater 执行接力 |
| `b95160d` | 同步四轮设置规格测试 |
| `15fc268` | 同步密钥验证、路径控件、变量与预览、四个快捷预设、独立单条消息及配置迁移、日记路径与链接 |
| `9f89378` | 同步快捷控件布局及 CSS |
| `0baad98` | 历史验证证据不作为本轮通过依据；直接运行主项目 harness 测本 fork |
| `76c5e3d` | 3.2.15 发布标记，最终统一 bump |
| `670455a` | 补齐设置 UX、变量控件、失焦校验与国际化，保留已移植网络实现；不带 updater、图床接力 |
| `3370690` | 3.2.16 发布标记，最终统一 bump |
| `03dbc94` / `004175b` | 同步中文 YAML key 与块标量修复、配套单测；插件与模板模拟器契约验证 |
| `83ea0ad` | 最终版本对齐 3.2.17 |

## 市场版保留项

- `id=wechat-note-helper`、`name=Bi Ji Tong Bu`、作者与 `minAppVersion=1.8.7` 保持。
- Obsidian typings 精确固定 `1.12.3`；移动端流式附件运行时检测 `appendBinary`，旧宿主保留远程链接与待办。README 中英披露该能力需要 1.12.3。
- 无 `src/updater/`、无自动更新设置、无图床上传接力、无 Templater 插值执行。
- 保留弱版本提醒、`stripPromoQrImages`、静态二维码 data URI、空 `getSettingDefinitions()`、公开 `Platform`、`window` 定时器、`js-md5` 与 `js-sha256`。
- 保留三条带限定元素的 VIP `is-hidden` CSS。
- 更新 README、模板变量与独立消息命名说明；修正旧文档中错误的 Templater 接力声明。

## 复审与真机发现的修复

- 补回卸载时附件待办队列的强制 flush。
- 调试手动同步与其纯本地化重试不授权云端删除；实际后台同步继续按该轮有效设置执行。
- 附件待办支持父目录改名，迁移该目录下的记录并保留预算和重试状态。
- 合并消息的 `buildMessageView` 注入 `rawTitle/messageTitle/messageType`，与变量选择器一致。
- G3 发现无密钥时会员区裸露加载中与裂图：容器初始隐藏，清空密钥作废旧响应，有效验证后显示。新增三条行为回归测试。

两轮整体 Codex 审查及定向复审均使用显式 `service_tier="fast"`；最终定向复审确认上述修复通过。

## 故意不带

- `83ea0ad` 之后的模板缺正文警告、首次合并提示与自动打开、每篇一个文件夹预设、合并文件名清空语义、新消息设置分组。
- 后续 `00f654d` 的预设应用/撤销后刷新活跃本地化器修复尚未发版，按范围排除。因此应用预设后，已经初始化的本地化器参数不会立即刷新；相关后续验收不计入本轮。
- `worktree-diary-link-confirm` 分支的日记链接确认弹窗。
- 上传接力与改名接力真机用例不适用市场版。
- `productionWecomReadiness.spec.ts` 属于主项目生产网络观察器的工具测试，依赖独立 harness，不孤立复制；本 fork 使用主项目现有真机 harness 验证。

## 验证结果

G1–G4、市场版网络组和补充设置真机组已通过。单条消息首次因测试端连接重置失败，保留原失败记录，独立重跑完整场景后通过。

| 门 | 结果 |
|---|---|
| G1 构建、官方扫描与 bundle 禁词 | Node 18 build 成功，574.4 KB；Node 20 `npx eslint .` 零问题；八项 bundle 禁词均为 0；`app.plugins` 五处均来自 daily-notes vendor |
| G2 Node 18 全量 Jest | 145 suites / 1899 tests 全通过；二维码剥离与两套弱提醒合规测试均通过 |
| G3 Obsidian 1.13.4 设置、拉取、弱提醒及截图 | 最终构建两项全部通过；18 个输入控件，两轮 40/67 个控件、14/25 个真实写值文本框、操作失败均为 0；无密钥隐藏、真键入、seed 真落盘与清理验证、弱提醒跳社区插件页且文件不变均通过；三张要求截图已逐张查看 |
| G4 身份、披露、静态推广与无接力自检 | 逐条通过；manifest/package/versions 为 3.2.17，lockfile 同步；新增控件 API 早于 1.8.7，appendBinary 是 1.12.3 的可选能力且有运行时守卫与双语披露 |
| 市场版网络组 | 30/30 通过；最终构建受影响的目录迁移、删除互斥、无同步重试、online 重试四项另跑均通过。长组前半使用修复过程中的构建，全部用例保留逐项指纹；最终四项补跑覆盖后续核心修改，G3 使用最终构建 |
| 设置、单条消息、邮件补充真机组 | 四个场景全部通过：密钥验证；完整路径控件与四预设；单条消息八种类型 × 四种模式 × 开关矩阵及同名/更新/日记/阅后即焚；邮件 16 组合矩阵及回退/更新/阅后即焚。单条消息首次运行测试端 ECONNRESET，独立完整重跑通过，原失败不抹除 |
| 模板模拟器契约 | 插件侧 14 条通过；模拟器侧 9 条通过 |
| G5 push / Release / 版本提醒端点 | 按用户边界不执行 |
| G6 上架后市场安装与教程部署 | 本次未发布，不执行 |

证据索引：

- G1 build：`/tmp/market-sync-build-release.log`；官方扫描：`/tmp/market-sync-eslint-final.log`；逐条静态合规：`/tmp/market-sync-compliance.json`。
- G2 全量单测：`/tmp/market-sync-jest-final.log`。
- G3 最终组：`/tmp/market-sync-g3-release.log`。弱提醒用例只在隔离 QA vault 内把 manifest 版本降为 `3.2.4`，以触发线上端点当时返回的 `3.2.8`；验证版本获取、提醒、跳转和文件不变。正式 manifest 保持 3.2.17，线上提醒端点未更新；该实验不表示线上已经发布 3.2.17。
- 网络 30 项：`/tmp/market-sync-network-e2e.log`（末行 `30/30 passed`）；最终四项：`/tmp/market-sync-final-regressions.json`、`/tmp/market-sync-final-regressions.log`，run ID 为 `20261019-155747-ms7r`、`20261019-155758-al08`、`20261019-155832-5zfg`、`20261019-155905-ckwj`。
- 路径/邮件补充组：`/tmp/market-sync-settings-e2e-results.json`；消息完整重跑：`/tmp/market-sync-retry-message.json`、`/tmp/market-sync-retry-message.log`。
- 模板契约：`/tmp/market-sync-playground-tests.log`（14/14）；模拟器侧：`/tmp/market-sync-simulator-tests.log`（9/9）。
- 代码整体复审：`/tmp/market-sync-review-final.log`；问题修复后的定向复审：`/tmp/market-sync-review-fixes.log`；记录事实核对：`/tmp/market-sync-review-report.log`。

最终 bundle SHA-256：`f53dbb9d8c34b6f316446e35567547919aeb2cfaad2d1db51f3afe3106876712`。版本 bump 不改变 bundle 字节；产物不提交。

最终 G3 设置证据：`market-wechat-note-helper-settings-input-pull-1792397061134`；弱提醒证据：`market-wechat-note-helper-update-reminder-1792397093174`。完整路径组：`market-3-2-17-settings-four-iterations-20261019-155530-xig5`；邮件组：`market-3-2-17-email-independent-settings-20261019-160142-764c`；消息重跑组：`market-final-message-separate-settings-20261019-160525-adg4`。

本地提交：`7e6f87e` 保存旧网络同步成果；`8cbaa34` 补齐已发版功能及回归修复；`5769fda` 对齐 3.2.17 版本。另提交本记录的最终验证结论。

QA 密钥、vault 与带凭据日志不提交。单测和构建日志在 `/tmp/market-sync-*.log`；隔离真机运行证据在主项目 `tests/real-obsidian/runs/`（指向 `/data/obsidian-plug-e2e-runs`）。每条记录包含源目录、版本与 bundle SHA-256。
