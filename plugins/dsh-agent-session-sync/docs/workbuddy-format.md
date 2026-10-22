# WorkBuddy 会话存储格式（JSONL）

> 本文档说明 WorkBuddy（字节跳动 coding agent）本地会话的数据格式，供
> `dsh-agent-session-sync` 的 `workbuddy` provider 读取实现与后续维护参考。
> 所有信息均来自对 `~/.workbuddy` 真实数据的只读采样，**不要依赖本文档去写回或修改该目录**。

## 存储布局

```
~/.workbuddy/projects/
  <编码目录>/          # 按项目 + 时间编码的目录，目录名通常形如 c-Users-Administrator-… 或 d-workBuddy_Space-头条
    <sessionId>.jsonl       # 一个 JSONL 文件 = 一次会话的全部事件（每行一个 JSON 事件）
    <sessionId>.meta.json   # 极简元数据，一般只有 {codebuddy.ai/hostKind, acpConnectionId} 之类，**没有 title 也没有 cwd**
```

- **meta.json 里没有 `title` / `cwd`**（实测只有 `codebuddy.ai/hostKind` 和 `acpConnectionId`），
  所以标题和项目目录都必须从 `.jsonl` 里读。
- 真实会话 cwd 由每个事件自带的 `cwd` 字段提供（如 `d:\workBuddy_Space\头条`）；
  该字段缺失时再用 user 消息 `<user_info>` 里的 `Workspace Folder:`，
  最后才回退到编码目录名解码。**不要依赖有损的目录名编码**来还原 cwd。
- 标题优先 `ai-title` 事件的 `aiTitle`，回退到首条真实 user 文本（只取第一句，避免把整段自动化 prompt 当标题）。
- 文件名有两种：会话是 `<uuid>.jsonl`，子代理运行是 `agent-<hash>.jsonl`。

## ⚠️ 删除是软删除，必须以 `workbuddy.db` 为准

WorkBuddy **从不删除磁盘上的 transcript**：用户在界面里「删除会话」只是往
`~/.workbuddy/workbuddy.db` 的 `sessions` 表写一个 `deleted_at` 时间戳，`.jsonl` 文件原封不动留着。
同理，`agent-<hash>.jsonl` 这类子代理运行**根本没有对应的会话行**。

所以只扫 `projects/**.jsonl`，会把用户早已删掉的会话和子代理运行一起当成可导入会话列出来。
实测某台机器：磁盘 47 个 `.jsonl`，其中 **39 个带 `deleted_at`、2 个是 `agent-*`**，界面里只有 9 个真实会话。

正确做法是**以 `sessions` 表为准**（只读打开）：

```sql
SELECT id, title, cwd, deleted_at, updated_at FROM sessions
```

- `deleted_at` 非 NULL → 跳过（用户已删除）。
- 表里没有该 id → 跳过（子代理运行 / 孤儿文件）。
- 表里的 `title` 常常就是界面显示的短标题（如 `Token看板每日刷新`），比从 prompt 猜的准，应优先采用。
- 表里的 `cwd` 是真实绝对路径，可直接当分组键。

数据库读不到时（文件缺失 / `node:sqlite` 不可用）应优雅退化：继续扫 transcript，只是失去删除过滤。

## 事件类型总览

对一份真实会话采样（453 行）的事件类型分布：

| 事件类型 | 数量 | 说明 |
| --- | --- | --- |
| `message` | 68 | `role=user`（含注入上下文）或 `role=assistant` |
| `function_call` | 122 | 工具调用 |
| `function_call_result` | 122 | 工具结果（注意：不是 `function_call_output`） |
| `reasoning` | 58 | 模型思考 |
| `file-history-snapshot` | 82 | 文件历史快照，**噪声，导入时跳过** |
| `ai-title` | 1 | 会话标题 |

每个事件都有 `id`、`timestamp`（毫秒）、可选的 `parentId`（父事件，构成一棵回复树）。

## 各事件类型格式

### `message` — user 消息

真实用户输入被**包进一段注入的系统上下文**，核心内容在 `<user_query>…</user_query>` 标签里
（`<system-reminder>`、`<user_info>`、`<current_time>`、`<craft_mode>` 等均为注入噪声）。

```json
{
  "id": "d6c761f9-…",
  "timestamp": 1789780149256,
  "type": "message",
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "<system-reminder data-role=\"user-context\">\n<user_info>…</user_info>\n…\n<user_query>今天有什么值得写的热点微头条选题？</user_query>\n…</system-reminder>"
    }
  ],
  "cwd": "d:\\workBuddy_Space\\头条"
}
```

提取规则：

1. 若存在 `<user_query>…</user_query>`，取其中的文本为真实用户消息。
2. 否则剥离所有注入标签（`system-reminder`、`user_info`、`identity_context`、`current_time`、
   `craft_mode`、`additional_data` 以及其余 `<…>` 标签），剩余非空文本当作用户消息。
3. 若剥离后为空（自动化 / 定时任务会话没有手动输入），该 turn 视为无 user 消息，跳过。

> ⚠️ **自动化会话的 `<user_query>` 是嵌套的**：一个**未闭合**的外层 `<user_query>` 装着
> 自动化 run-book（正文只是 `"."` 加 "You MUST follow these steps in order…"），
> 真正的任务在**内层**的另一个 `<user_query>` 块里，两者**共用同一个 `</user_query>`**。
> 实测一段文本里 `<user_query>` 出现 2 次而 `</user_query>` 只有 1 次。
> 因此**不能用第一个开标签做懒惰匹配**，要取**最后一个** `<user_query>` 开标签到其后闭合标签之间的内容，
> 并丢弃只含 `.` 或含 run-book 提示的块。否则标题会变成 `"."` 或整段执行说明。

### `message` — assistant 消息

```json
{
  "id": "ff97e0022c…",
  "parentId": "2b979709-…",
  "timestamp": 1789780227447,
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "output_text", "text": "今早七源热搜已扫完，去重合并后筛出这批候选…" }
  ]
}
```

### `reasoning` — 模型思考

```json
{
  "id": "db027943-…",
  "parentId": "d6c761f9-…",
  "timestamp": 1789780161157,
  "type": "reasoning",
  "rawContent": [
    { "type": "reasoning_text", "text": "The user wants today's hot topic recommendations…" }
  ],
  "content": [],
  "providerData": {
    "messageId": "48bbcb82aeab42a4af3548a2c407952a",
    "model": "glm-5.3-flash",
    "requestModelId": "fast-model",
    "requestModelName": "快速",
    "traceId": "9c03dd1116804c2ca86c8b82694a5fb6",
    "conversationRequestId": "9c03dd1116804c2ca86c8b82694a5fb6",
    "agent": "…"
  }
}
```

思考正文通常取 `rawContent[].text`（`reasoning_text`）；`content` 多数为空。

### `function_call` — 工具调用

```json
{
  "id": "48bbcb82…",
  "parentId": "db027943-…",
  "timestamp": 1789780161171,
  "type": "function_call",
  "callId": "call_366e5463e8424383bc20e99c",
  "name": "WebSearch",
  "arguments": "{\"freshness\":\"d1\",\"query\":\"微博热搜榜 今日榜单\"}",
  "providerData": {
    "messageId": "48bbcb82aeab42a4af3548a2c407952a",
    "model": "glm-5.3-flash",
    "requestModelId": "fast-model",
    "requestModelName": "快速",
    "traceId": "9c03dd1116804c2ca86c8b82694a5fb6",
    "conversationRequestId": "9c03dd1116804c2ca86c8b82694a5fb6",
    "agent": "…",
    "reasoning": "…",
    "argumentsDisplayText": "…"
  }
}
```

- `arguments` 是 **JSON 字符串**（即反序列化后为对象）。
- 命名可能不总是 `callId`，老 schema 的事件可能把调用放在 `event.message` 里内嵌（见 Provider 兼容性）。

### `function_call_result` — 工具结果

```json
{
  "id": "307ce093…",
  "parentId": "48bbcb82…",
  "timestamp": 1789780162345,
  "type": "function_call_result",
  "callId": "call_366e5463e8424383bc20e99c",
  "name": "WebSearch",
  "status": "completed",
  "output": {
    "type": "text",
    "text": "# Search Results for \"微博热搜榜 今日榜单\"…"
  }
}
```

要点：

- `output` 可能是**对象**（最常见，如 `{type:'text', text:…}`）也可能是**纯字符串**，解析时两种都要处理。
- `status`：`completed` 表示成功；`error` / `failed` 等表示出错，应映射为工具结果的 `isError: true`。

### `ai-title` — 会话标题

```json
{
  "id": "d880d233-…",
  "timestamp": 1789780155420,
  "type": "ai-title",
  "aiTitle": "推荐热点微头条选题",
  "sessionId": "03a060f0-43a1-4db9-8eca-9442d0fdb043",
  "cwd": "d:\\workBuddy_Space\\头条"
}
```

### `file-history-snapshot` — 文件快照（噪声）

```json
{
  "id": "ffaa952d-…",
  "timestamp": 1789780152738,
  "type": "file-history-snapshot",
  "isSnapshotUpdate": false,
  "snapshot": { "messageId": "…", "trackedFileBackups": {} },
  "cwd": "d:\\workBuddy_Space\\头条"
}
```

导入时应直接跳过该类型。

## 关键：把分散事件归组成「一个 run」

同一 assistant 回合（一次模型答复）会产生多个事件：`reasoning` → `function_call` → 多个
`function_call_result` → `message(assistant)`。它们靠 **`providerData.messageId`** 归组到同一次
模型请求，它就是 provider 里 `runKeyOf(event)` 采用的归组键。

一条完整对话的时间线示意：

```
message(user) ──> reasoning(messageId=A) ──> function_call(callId=C, messageId=A)
  ──> function_call_result(callId=C, messageId=A) ──> message(assistant, messageId=A)   ← 构成 run A
message(user) ──> reasoning(messageId=B) ──> …                                          ← run B
```

由此 provider 把 `reasoning` 映射为 `reasoning` block、`function_call` 映射为 `tool-call` block +
占位 `toolResult`、`function_call_result` 回填该 `toolResult`、`message(assistant)` 映射为 `text` block。

## Provider 兼容性说明

生产 `workbuddy.js` 解析事件时做了多一层兼容：

- 事件内容可能在 `event.message` 内嵌独立 schema（见历史 `assistant` 事件类型）。
- `function_call` / `function_call_result` 也可能通过 `event.message` 包裹。
- 沉默的 `function_call_result`（有调用没结果）会补占位结果；只有结果没有调用会补 `tool-call` block，
- 以满足 `docs/adding-provider.md` 中的硬性不变量：**每个 tool-call 在同 run 内恰好一条结果，id 全会话唯一**。