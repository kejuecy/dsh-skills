# 新增一个目标 agent（sink）

本插件的两个方向都是「导入」，只是站在接收方看：

| 方向 | 用户看到的名字 | 通道 | 模块 |
| --- | --- | --- | --- |
| 第三方 → DSH | 导入到 DSH | `/session-import/*` | `lib/host/providers/<id>.js` |
| DSH → 第三方 | 导入到其他 agent | `/session-export/*` | `lib/host/sinks/<id>.js` |

代码里第二个方向仍叫 `export`/`sink`（对 DSH 而言确实是把数据送出去），但所有用户可见
文案统一说「导入」，避免读成「主功能 + 附加的反向功能」。

provider 负责「第三方历史 → DSH」，sink 负责「DSH 会话 → 第三方」。两者共用同一份
中间表示（Conversation），所以**同一份历史格式通常可以同时提供 provider 和 sink**：
读得懂就写得懂。`sinks/registry.js` 只认有 `write` 函数的模块，所以一个文件同时导出
`list/load`（provider 侧）和 `write`（sink 侧）是完全合法的。

## 1. 目录与注册

sink 放在 `lib/host/sinks/<id>.js`，然后在 `SINK_ORDER` 里加一行：

```js
const SINK_ORDER = [
  { id: 'workbuddy', module: './workbuddy.js' },
  { id: 'claude-code', module: './claude-code.js' },
  { id: 'codex', module: './codex.js' },
  { id: 'cursor', module: './cursor.js' },
  { id: 'zcode', module: './zcode.js' },
  { id: 'kimi', module: './kimi.js' },
  // ← 新增目标在这里加一行
];
```

模块加载失败、或没有导出 `write`，都会被安全跳过，不影响其他目标。

## 2. 必须导出的接口

```js
export const id = 'workbuddy';        // 目标 id：小写、稳定
export const label = 'WorkBuddy';     // 面板上显示的名字
export const description = '一句话说明';
export const overwrite = true;        // 该目标是否支持覆盖已有会话

/** 这台机器上能不能写。 */
export async function status() {
  return { available: true, location: '~/.workbuddy/projects', error: null };
}

/**
 * 写入一份会话。
 * @param conversation - 来自 `dsh-source.js` 的标准化会话
 * @param options - 见下表
 * @returns 计划 / 结果对象
 */
export async function write(conversation, options) { ... }
```

`options` 字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `dryRun` | boolean | **默认 true**。只返回计划，不落盘 |
| `confirm` | boolean | 显式确认写入；没看过计划就不该为 true |
| `force` | boolean | 跳过「目标应用正在运行」的检查 |
| `sessionId` | string | 指定目标会话 id；不传则生成 |
| `cwd` | string | 目标项目路径（决定归档到哪个项目） |
| `title` | string | 覆盖标题 |
| `targetProject` | string | 指定目标项目目录名 |
| `flattenTools` | boolean | 把工具调用与结果写成正文（兼容模式） |

`write` 的返回值会原样进面板，建议至少包含：

```js
{
  dryRun: true,            // 这次是不是只预览
  sessionId: '…',
  target: 'C:\\…\\x.jsonl',
  exists: false,           // 目标是否已存在
  rows: 572,               // 写/将写多少行
  backup: null,            // 覆盖时的备份路径
  notes: ['…'],            // 任何降级都要在这里留话
}
```

## 3. 硬性规则

这四条是契约，`sinks/shared.js` 提供了对应工具函数：

1. **默认 dry-run。**`write()` 在 `options.confirm !== true` 时必须只算不写。
   写盘用 `atomicWrite()`（临时文件 + `fsync` + `rename`），不要直接 `writeFileSync`。
2. **覆盖前先备份。**用 `backupFile()`，返回备份路径并放进 `backup`。
   目标不存在时返回 `null`，不要编一个假路径。
3. **不写正在运行的应用。**用 `assertNotRunning()` / `isRunning()` 判断；
   除非调用方给了 `force`，否则应当抛错而不是硬写。
4. **降级必须留备注。**任何「格式不支持、字段被丢弃、模式被简化」都 `notes.push(...)`。
   静默丢失比报错更糟。

另外几条来自实测的坑：

- **上下文压缩在上游完成，sink 不用管。**`export-service.js` 会在调用 `write()` 之前用
  `compress.js` 把超出模型窗口的会话压到能打开的大小（截断工具输出/正文、丢思考块、
  必要时省略中段并插入说明消息），所以 sink 拿到的可能是「回合变少」的会话——
  把它当正常会话写即可，不要假设 `conversation.turns` 与源会话一一对应。
  自己需要别的阈值时，把 `options.contextLimit` / `options.completionReserve` 透传下去，
  不要另写一套估算。
- **会话 id 必须符合目标应用的命名规则。**WorkBuddy 的读取侧只认 UUID 形态的
  文件名，写一个好看的短 id 会得到一个「文件存在但界面永远不显示」的会话。
  这类不合法输入应当**当场抛错**（`error.code = 'bad-id'`），而不是写下去再让人猜。
- **同一回合的多个事件要共用分组键。**WorkBuddy 用 `providerData.messageId` 把
  message / function_call / function_call_result 聚合成一个 run；漏写这个字段会让
  读取侧把每个事件当成独立 run，工具调用数直接翻倍。

## 4. 测试

`test/export.test.mjs` 里已有可复用的夹具（临时 `~/.dsh` + 临时目标家目录）。
新 sink 至少覆盖：

- dry-run 不产生任何文件；
- 正常写入后，用**本插件自己的 provider** 读回来，轮数/工具调用数与源一致；
- 目标已存在且 `overwrite` 关闭时拒绝写入；
- 覆盖时确实产生了备份，且备份可读。

回读校验是这类写入最有效的自检：写入方和读取方是两套独立实现，
两边对得上基本就说明格式没错。
