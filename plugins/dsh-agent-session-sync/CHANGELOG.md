# Changelog

## 0.3.9 — 2026-10-22

### 修复：导出的会话在 WorkBuddy 里出现空的「提问」卡片

- 导出到 WorkBuddy 时，DSH 的「向用户提问」（`AskUserQuestion` / `ask_user_question`）工具调用
  不再原样写入。WorkBuddy 会按工具名把它当成自己的原生提问工具，于是一条已结束的会话里出现一张
  「看似待回答」的卡片：`arguments` 是空的 `{}`（DSH 侧问题不存在这里），卡片没有题目可看，
  按钮点了也没有反应。
- 现在这类调用被转换成助手正文里的纯文本问答（问题与用户所选答案来自工具结果），内容一条不丢；
  计划卡片会提示「N 次『向用户提问』已转为文本问答」。
- 已在 25 个真实 DSH 会话上验证：15 次提问调用全部转换，正文里保留完整的「问题 → 答案」。

## 0.3.8 — 2026-10-22

### 改进：侧边栏名称体现双向能力

- 侧边栏入口与页面标题从「导入会话」改为「**会话互导**」（英文 `Session Transfer`）——
  插件是 DSH 与本机各 coding agent 之间的双向一次性转移：两个方向都是手动导入导出，
  「互导」点明双向，又不像「同步」那样暗示有后台自动同步。功能逻辑无任何变化。
- `docs/usage.md` 的操作路径同步更新。

## 0.3.7 — 2026-10-22

### 改进：WorkBuddy 有了应用图标

- 导出页「导入到」列表里的 WorkBuddy 卡片，以及导入页来源栏里的 WorkBuddy 行，现在都带应用图标
  （之前两边都是光秃秃的文字）。图标取自本机安装的 WorkBuddy 官方应用资源（88px PNG，base64 内联），
  渲染样式与其它来源图标一致（20px 圆角小方块）。
- 图标渲染是按 id 查 `SOURCE_ICONS` 表，缺图标时自动省略 `<img>`，将来新增目标无需改渲染代码。

## 0.3.6 — 2026-10-22

### 改进：导入到 DSH 页面的界面

- **窄面板下来源栏改成横向芯片条**：`.ci-layout` 现在是一个尺寸容器（`@container`），
  宽度不足时来源列从 224px 竖列变成横向可滚动的芯片行，会话列表拿回整排宽度，不再被挤成半栏。
  用容器查询而不是媒体查询，是因为同一个面板在主区域里是宽的、在侧边栏里是窄的，只有它自己知道。
- **标签页带条数**：「导入到 DSH」后面显示未导入总数，不用点进去才知道有没有活要干。
- **底部显示「已选 N 条（G 个项目）」**：一眼看出这批选择是一个项目的活儿还是四个项目的。
- **「都已导入」时给动作**：以前只提示「可切换到全部查看」，现在旁边直接有按钮切过去。
- 底部动作条加上分隔线并固定不压缩，两页的按钮位置/观感统一（导出页的自造 `.ci-btn` 换成宿主的
  `P.Button`，保留无 primitives 时的回退）。
- 顺手合并了 `.ci-progress` 的重复声明。

## 0.3.5 — 2026-10-22

### 改进：导出到第三方 agent 不再需要先点「预览」

- 计划（目标文件、写入行数/消息数、这是新建还是更新、备份位置）现在是**自动**出现的：
  选好会话与目标就取，摆在同一屏上，主按钮一步写入。少一次点击，看到的信息一模一样。
- 安全底线没有放松，反而更严：`confirm: true` 只在**当前这组设置**的计划已经在屏幕上时才会
  发出。改了会话、目标或内容形式，按钮立刻变灰并重算——不可能写出一份用户没看过的计划。
- 计划用的就是写入自己那条代码路径（`dryRun` 只把写开关关掉），不是另写一套估算逻辑。

### 改进：写入改为 upsert —— 存在就更新那条，不存在才新建

- 导出 id 现在取自**源会话自己的 id**（原生会话是裸 UUID，本插件写的 `session-<uuid>` 去掉
  前缀后同样是合法 UUID）。于是同一句话只有一个落点：
  - WorkBuddy 里没有 → 新建；
  - WorkBuddy 里已有 → **原地更新那一条**，写入前自动备份原文件。
- 之前每次导出都新生成 UUID，导致两件事同时失真：面板上的「覆盖同名会话」开关**永远不可能
  生效**（新 id 不会撞车），以及同一条 DSH 会话导出三次就在 WorkBuddy 里多出三条同名会话。
- 因此**去掉了「覆盖」勾选**：存在与不存在已经有确定答案，不需要用户替系统做决定。计划卡片
  用徽标说明将发生哪种（`将新建会话` / `将更新已有会话`），写入后变成（`已新建` / `已更新`）。
- 源 id 不是 UUID 时（测试夹具、别处导入的会话）才回退到随机 UUID。

### 修复：导出页的样式泄漏到了导入页

- 导出页的 `.ci-list` / `.ci-empty` / `.ci-error` 与导入页**同名**且声明在后面，于是导入页的
  会话列表被 `max-height:340px` 压住、空状态和错误提示的字号/内边距也被改写。
- 所有导出页样式已收敛到 `.ci-export` 作用域下，导入页恢复成撑满面板；同时删掉了几条重复声明。

### 界面细节

- 动作区固定在面板底部（`.ci-export-actions`），长会话列表滚动时不用再往下翻找按钮。
- 左右两栏在窄面板下自动改为上下堆叠（`flex-wrap` + `flex-basis:260px`）。
- 目标卡片不再显示 `overwrite` 徽标（那是能力标记，不是本次行为），不可用目标改为直接显示原因。
- 计划卡片：路径用等宽字体、状态用徽标、写入完成后转完成态并显示备份路径。
- 新增 `test/export.test.mjs` 3 项（稳定 id 派生、原生 UUID 直接复用、连导两次是原地更新）。
  测试总数 92 → 95。

## 0.3.3 — 2026-10-22

### 修复：重复导入同一个会话改为「合并」，不再整份覆盖

- 以前重复导入是「删掉旧会话 + 按来源重写一遍」。只要你在 DSH 里接着聊过，那几轮本地
  对话就会随旧会话一起被删掉——这正是用户反馈的问题。
- 现在重复导入是**追加式合并**：读回原会话的日志，与来源对话逐回合比对，找出两边的共同
  前缀（也就是上次导入已经写过的部分），只把来源**新增**的回合追加到原会话末尾。全程不
  删除任何东西，所以：
  - 你在 DSH 里的本地追问、压缩摘要都保留；
  - 来源没有新内容时**一个字都不写**，结果行显示「已是最新，原会话没有变化」；
  - 合并失败时原会话保持原样，不会留下半截日志。
- 追加的事件序号接着原日志往下排（`assertContiguous` 要求从 0 连续），回合号同样接续，
  时间戳不早于原日志的最后一条——日志结构仍然完全合法，能正常打开、续聊、导出。
- 新增 `【导入说明】` 的剥离：比对前先把首次导入写入的说明去掉，否则第 1 个回合永远对不
  上，任何重复导入都无法识别重叠部分。旧版本写入的、措辞已变化的说明也能被「来源是原
  文本后缀」这一条兜住。
- 原会话正在 DSH 里打开时**绝不写入**（它内存里有一份，落盘会把写入覆盖掉）：改为导入成
  新会话，并提示把旧的手动删掉。合并时被别的持有者抢走写锁（`busy`）同样按这条处理。
- 读取到写入之间原日志被改动（序号校验失败）时报 `conflict`，同样退到新建会话——绝不在
  别人正在写入的会话上做整份重写。
- 只有在必须兜底时才整份重写，且结果会如实说明是哪一种：`已整份重写该会话`，或
  `也无法覆盖原会话，已导入为新会话`。
- 导入结果行新增 `merged` / `addedTurns`，文案为「已合并到原会话，续接 N 个回合」。
- `options.merge: false` 可退回旧的覆盖行为。
- 新增 `lib/host/merge.js`（比对 + 追加）与 `lib/host/reimport.js`（重导入策略：合并 →
  打开中 → 抢锁 → 整份重写），`runJob` 里的分支判断收敛成一个 `persistConversation`。
- 新增 `test/merge.test.mjs`（21 项）。测试总数 71 → 92。

## 0.3.2 — 2026-10-22

### 新增：导入到 DSH 后自动归入对应工作区

- DSH 的侧边栏按**登记的工作区**（`$DSH_HOME/storages/workspace.json`）分组，不是按会话
  自己的 `cwd` 分组；导入走的是会话持久化接口，绕过了工作区登记，所以以前所有导入的会话
  都堆在「未分组」。
- 现在导入一条会话后会：按来源的项目目录找到已有工作区，没有就新建一个（标题取目录名，
  例如 `DeepHarness`），再把会话 `attachSession` 进去。同一目录反复导入只会复用一个工作区。
- 原对话没有项目目录（无 cwd、目录已不存在、或就是用户主目录）时不建工作区，仍落在
  「未分组」——「纯会话」不该被塞进一个虚构的工作区。
- 工作区服务不可用或 attach 被拒时只记一条警告，**不影响会话导入本身**。
- 导入结果行新增去向说明：`· 已归入工作区「X」` / `· 已新建工作区「X」` /
  `· 未分组（原对话没有工作区信息）`；完成提示同步改写。
- 接口新增 `options.groupByWorkspace`（默认 `true`），需要保持旧行为时可传 `false`。
- 新增 `test/workspace.test.mjs`（7 项）。测试总数 64 → 71。

## 0.3.1 — 2026-10-22

### 改进：「导入到其他 agent」只列页面上看得见的会话

- 左栏来源改成 DSH 页面自己的会话列表（浏览器侧 `ctx.sessions.list`），不再扫
  `~/.dsh/sessions/**` 后全量列出。效果：
  - 别的 workspace 里没出现在页面的会话、被页面隐藏的会话不再混进列表；
  - 子 agent 会话（`[dsh-*:delegated]` 这类，页面上只能从父会话进入）不再单列；
  - 空白会话（还没发过消息）不再出现——它们以前能被选中、点「开始导入」才报
    「没有可导出的内容」。
- 面板打开期间会跟随会话列表变化：新建会话自动出现，删掉的自动消失。
- 左栏标题下增加一行说明 `只列出页面上的 N 个会话（本机共 M 个）`，避免看起来像丢条目。
- 这个 DSH 版本没有会话列表服务时，退回列出本机全部会话并提示原因。
- Host 端点 `POST /session-export/sources` 新增可选 `ids`，返回
  `{ conversations, pageOnly, total, hidden }`；不传 `ids` 行为与以前一致。
- 新增 `test/client-scope.test.mjs`（3 项，直接加载构建产物验证范围），
  `test/export.test.mjs` 增 3 项。测试总数 57 → 63。

## 0.3.0 — 2026-10-22

### 新增：把 DSH 会话导入到其他 agent（双向互导的另一半）

- 面板增加「导入到其他 agent」标签页，把本机 DSH 会话写进本机第三方 agent。当前支持 **WorkBuddy**
  （写入 transcript + 注册 `workbuddy.db` 的 `sessions` 表，侧边栏可见）。
- 两段式写入：不传 `confirm` 只返回计划（目标文件、行数、是否覆盖、备份路径），
  看过计划再确认才落盘；覆盖前自动备份 transcript 与数据库；目标应用运行中拒绝写入。
- sink 架构与 provider 对称（`lib/host/sinks/`），新增目标见
  [docs/adding-sink.md](docs/adding-sink.md)。未实现的目标缺少 `write` 会被安全跳过。
- 目标没有会话索引时不再拒绝，改为首次导入创建最小表结构（列从写入行派生，
  避免 `no such column`）；`workbuddyHome()` 修正覆盖路径解析，索引不再落到上一级目录。
- 该方向端点同时接受 `{ id, target, options }` 与扁平 `{ sourceId, targetId, … }` 两种载荷。

### 新增：同一会话再次导入时覆盖

- 导入记录里已有 `sessionId` 时，再次导入同一个远程会话会**复用该 id 重写**原 DSH 会话，
  不再留下重复副本。后端提供删除入口时先删除再写入（`replaced: true`）；不提供时降级为
  新建，并在导入结果里明确提示「原会话仍保留，可手动删除」。
- 面板的导入结果显示「已覆盖原会话」，与首次导入区分开。
- 新增 5 项测试（`test/reimport.test.mjs`）覆盖首次导入、覆盖、无删除能力降级、默认不删、
  非法 id 归一化。

### 修复（导入到其他 agent 方向）

- 读取 DSH 会话时工具调用重复计数：`tool/result` 在更晚的 run 才到达（并行调用、子代理续跑）
  时结果被挂到错误的 run 上，「补齐配对」又合成第二个工具调用块。实测 191 次调用的会话被
  读成 195 个块。改为按调用 id 全局定位归属 run，配对修复也用全局键，21 个真实会话精确对齐。
- 写入时思考内容被并进正文（`【思考】` 前缀），导回后思考变成普通正文、思考计数归零。
  改为按真实 WorkBuddy 格式写成独立的 `reasoning` 事件。
- 截断标记每次往返叠加：该方向的 `clampText` 改为幂等（导入到 DSH 侧的 `clamp` 未改动）。
- WorkBuddy 导入的用户提示提取改为注入标签白名单（`system-reminder`、`current_time`、
  `previous_*` 等 19 个）。原通用规则 `/<[a-z_][^>]*>/g` 会删掉用户正在讨论的
  `<view>`/`<text>`/`<div>` 以及 `` `<id>.json` `` 这类文本。该改动只影响 workbuddy 来源，
  其他 provider 与导入流程结构均未变动。

## 0.2.4 — 2026-10-21

- 重新发布到 npm。0.2.2 已被撤回，0.2.3 被 npm staged placeholder 占用，因此使用 0.2.4 发布。
- 功能与 0.2.2 一致；预发布检查、27 项测试与打包清单保持通过。

## 0.2.2 — 2026-10-20

- Host 导入服务拆分为 state/jobs/scan 模块，端点错误结构统一。
- Kimi 新增 Kimi Code CLI 会话目录（`~/.kimi-code` / `KIMI_CODE_HOME`），Windows/Linux 也可用。
- 跨平台支持：应用数据目录按 macOS / Windows / Linux 解析，cwd 使用 `path.isAbsolute`，SQLite 统一优先 `node:sqlite` 并提供 Windows 安全的 `file:` URI 回退。
- CI 覆盖 ubuntu-latest / macos-latest / windows-latest。
- 修正来源展示顺序为 Codex、Claude Code、Cursor、ZCode、Kimi，并更新界面预览截图。

## 0.2.1 — 2026-10-20

- 精简来源列表，仅保留开源工具的本地历史导入。
- 首次进入导入面板时显示加载状态（spinner + skeleton 占位），避免空白等待。

## 0.2.0 — 2026-10-20

首个公开版本。

- Sources: Codex (CLI and the Codex app bundled in ChatGPT.app share
  `~/.codex`), Claude Code, Cursor IDE (Agent/Composer), ZCode, and Kimi
  (Agent/Kimi Code).
- Sidebar panel with a source rail, conversations grouped by project folder,
  search, Unimported/All filter, group-level selection and a progress/results
  dialog with retry for failed imports.
- Two import modes: **Faithful** keeps reasoning/tool blocks as structured cards,
  **Resume-safe** keeps the same content as plain text so any model can resume.
- Imported sessions get a provenance note and an empty protected system head;
  sessions are written as v4 logs and their title projections are warmed.
- Provider plugin architecture: add a `lib/host/providers/<id>.js` module and one
  registry line to support another agent.
