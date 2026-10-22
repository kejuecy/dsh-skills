/**
 * WorkBuddy export sink — writes a neutral `Conversation` back into
 * WorkBuddy's own on-disk history, so a DSH (or other) conversation can be
 * resumed inside WorkBuddy.
 *
 * This file is the mirror image of `../providers/workbuddy.js` and lives in the
 * same package, so the two must agree on the format:
 *
 *   ~/.workbuddy/projects/<cwd-encoded>/<sessionId>.jsonl   event log
 *   ~/.workbuddy/workbuddy.db → sessions                    list index
 *
 * The transcript alone is not enough: WorkBuddy's sidebar is driven by the
 * `sessions` table, so a file written without a row is an invisible orphan.
 * Both halves are written here, and both are backed up first.
 *
 * Event shapes written (matching what the reader expects):
 *   { type: 'session-meta', id, sessionId, timestamp, meta }
 *   { type: 'ai-title',     id, aiTitle, ... }
 *   { type: 'message', role: 'user'|'assistant', content: [{ type:'input_text'|'output_text', text }] }
 *   { type: 'function_call',        callId, name, arguments }
 *   { type: 'function_call_result', callId, name, status, output: { type:'text', text } }
 *
 * Every row carries `id` and `parentId` (a single linked chain), because the
 * app rebuilds the conversation tree from that chain rather than from a
 * neutral, flat event order.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, assertNotRunning, backupStamp, ensureDir, flattenRun, millis, oneLine, toJsonl } from './shared.js';

/** Stable sink id. */
export const id = 'workbuddy';

/** Display label for the export target picker. */
export const label = 'WorkBuddy';

/** One-line description for the target picker. */
export const description = '写回 WorkBuddy 本地会话（projects/*.jsonl + sessions 索引）';

/** The id shape WorkBuddy's own reader accepts (see `providers/workbuddy.js`). */
const WORKBUDDY_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f-]{8,})$/i;

/**
 * The WorkBuddy session id that one source conversation should occupy.
 *
 * Exporting used to mint a fresh UUID every time, which made two things false:
 * the panel's "overwrite an existing session" switch was dead (a brand-new id
 * can never collide), and exporting the same DSH session twice left two
 * sessions in WorkBuddy's sidebar with no way to tell which was current.
 *
 * DSH names sessions with a bare UUID (native) or `session-<uuid>` (written by
 * this plugin), so the fix is to strip that prefix and reuse the result: the
 * export then lands on the same file every time, which is exactly what the
 * overwrite gate and the "existing session" badge describe.
 *
 * A source whose id is not a UUID (an imported conversation, a test fixture)
 * gets a random one — there is nothing stable to derive from it.
 *
 * @param conversation - neutral conversation.
 * @returns a WorkBuddy-compatible id, or undefined when none can be derived.
 */
function derivedSessionId(conversation) {
  const raw = typeof conversation?.id === 'string' ? conversation.id.trim() : '';
  if (raw === '') return undefined;
  const candidate = /^session-/i.test(raw) ? raw.slice('session-'.length) : raw;
  return WORKBUDDY_ID.test(candidate) ? candidate : undefined;
}

/**
 * The original WorkBuddy id this conversation came from, when the caller knows it.
 *
 * A session imported into DSH and then exported back has two possible ids: the
 * fresh DSH uuid it was given at import, and the id it already owns in
 * WorkBuddy. Picking the first one writes a *second* session beside the
 * original (same title, same project) instead of updating it, which is the
 * duplicate this helper exists to prevent. `originId` is advisory: the shape is
 * re-validated here, so a garbled entry falls back to the old behaviour rather
 * than failing the export.
 *
 * @param originId - candidate id supplied by the export service.
 * @returns a WorkBuddy-compatible id, or undefined.
 */
function preferredOriginId(originId) {
  const raw = typeof originId === 'string' ? originId.trim() : '';
  return raw !== '' && WORKBUDDY_ID.test(raw) ? raw : undefined;
}

/**
 * The project folder that already holds this session's transcript, if any.
 *
 * A round-tripped session must land back in the folder it came from: writing it
 * beside a *different* cwd would put the same id in two project folders, which
 * the sidebar shows as two sessions — the very symptom being fixed, just via a
 * different route.
 *
 * @param root - projects root.
 * @param sessionId - target session id.
 * @returns project folder name, or undefined when the id is new.
 */
function existingProjectDir(root, sessionId) {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(root, entry.name, `${sessionId}.jsonl`))) return entry.name;
    }
  } catch {
    // No projects folder yet: the computed name is the project's first name.
  }
  return undefined;
}

/** This target replaces an existing transcript when the id already exists. */
export const overwrite = true;

/**
 * Tools whose only job is to ask the user a question inside the source app.
 *
 * WorkBuddy has a native question tool and matches it by name, so exporting
 * the call verbatim produces a live-looking question card on a finished
 * transcript: `arguments` is `{}` on the DSH side (the question never lived
 * there), the card therefore shows nothing to answer, and its buttons are
 * dead. The question and the chosen answers survive only in the tool result,
 * which reads perfectly as text — so this sink drops the call and emits the
 * recorded Q&A as ordinary assistant text.
 */
const ASK_USER_TOOL = /^ask_?user_?question$/i;

/** Whether one tool-call block is an ask-the-user interaction. */
function isAskUserTool(call) {
  return ASK_USER_TOOL.test(String(call?.name ?? ''));
}

/** Process image that must not be running while we write. */
const EXE_NAME = 'WorkBuddy.exe';

/** Marker written into `session-meta` so re-imports are recognisable. */
const IMPORT_MARKER = 'dsh-agent-session-sync';

const HOME = os.homedir();

/**
 * The projects root transcripts live under.
 *
 * Follows the same `WORKBUDDY_HOME` contract as `../providers/workbuddy.js`
 * (the read side): the variable names the **projects root**. A value that is
 * clearly an app home (it exists and already contains `projects/`) is accepted
 * too, so both spellings work and the two halves of the plugin never disagree
 * about where a transcript lives.
 *
 * @param env - environment override.
 * @returns absolute projects root.
 */
export function projectsRoot(env = process.env) {
  const override = textEnv(env.WORKBUDDY_HOME);
  if (override !== undefined) {
    if (path.basename(override) !== 'projects' && fs.existsSync(path.join(override, 'projects'))) {
      return path.join(override, 'projects');
    }
    return override;
  }
  return path.join(HOME, '.workbuddy', 'projects');
}

/**
 * WorkBuddy home directory (the parent of `projects/`, holding the index).
 *
 * Derived from the override directly rather than from `path.dirname(projectsRoot())`:
 * when the override names a projects root that does not literally end in
 * `projects`, taking the dirname would place the index one level too high (a
 * temp override landed in `%TEMP%/workbuddy.db` instead of inside the fixture).
 *
 * @param env - environment override.
 * @returns absolute app home.
 */
export function workbuddyHome(env = process.env) {
  const override = textEnv(env.WORKBUDDY_HOME);
  if (override !== undefined) {
    // Same two spellings `projectsRoot` accepts, resolved to the app home.
    if (path.basename(override) === 'projects') return path.dirname(override);
    return override;
  }
  return path.join(HOME, '.workbuddy');
}

/** Trimmed absolute path from an env value, or undefined. */
function textEnv(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed !== '' && path.isAbsolute(trimmed) ? trimmed : undefined;
}

/** The session index database, a sibling of `projects/`. */
export function databasePath(env = process.env) {
  return path.join(workbuddyHome(env), 'workbuddy.db');
}

/**
 * Encode an absolute cwd the way WorkBuddy names its project folders.
 *
 * Observed on disk: `c:\Users\Administrator\WorkBuddy\DeepHarness` becomes
 * `c-Users-Administrator-WorkBuddy-DeepHarness` — drive letter lowercased,
 * every separator and the colon replaced with a dash. The existing folder name
 * wins when one already matches case-insensitively, so an export never creates
 * a duplicate project next to the real one.
 *
 * @param cwd - absolute working directory.
 * @param env - environment override.
 * @returns project folder name.
 */
export function encodeProjectDir(cwd, env = process.env) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return 'imported';
  const normalized = cwd.replace(/[\\/]+$/, '');
  const drive = /^([A-Za-z]):/.exec(normalized);
  let name = normalized.replace(/[\\/]+/g, '-').replace(/:/g, '-');
  if (drive !== null) name = `${drive[1].toLowerCase()}${name.slice(1)}`;
  name = name.replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'imported';

  try {
    const existing = fs.readdirSync(projectsRoot(env));
    const match = existing.find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (match !== undefined) return match;
  } catch {
    // No projects folder yet: the computed name is the project's first name.
  }
  return name;
}

/** Load `node:sqlite`, or null when the runtime lacks it. */
let sqlitePromise;
async function loadSqlite() {
  if (sqlitePromise === undefined) sqlitePromise = import('node:sqlite').catch(() => null);
  return sqlitePromise;
}

/**
 * Read the session index.
 *
 * The db is opened read-write on purpose: in WAL mode a read-only connection
 * still needs to touch `-shm`, which fails when the folder permissions forbid
 * it. Nothing is written here — only prepared SELECTs run.
 *
 * @returns `{ available, rows: Map<id, row>, userId }`.
 */
async function readIndex(env = process.env) {
  const dbPath = databasePath(env);
  const empty = { available: false, rows: new Map(), userId: 'local', dbPath };
  if (!fs.existsSync(dbPath)) return empty;
  const sqlite = await loadSqlite();
  if (typeof sqlite?.DatabaseSync !== 'function') return empty;
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    const rows = new Map();
    for (const row of db.prepare('SELECT * FROM sessions').all()) rows.set(row.id, { ...row });
    const first = db.prepare('SELECT user_id FROM sessions WHERE user_id IS NOT NULL LIMIT 1').get();
    return { available: true, rows, userId: first?.user_id ?? 'local', dbPath };
  } catch {
    return empty;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed / never opened.
    }
  }
}

/**
 * Create the minimum index schema used by an export.
 *
 * Only reached when WorkBuddy has never run on this machine. The column list is
 * derived from a real `buildSessionRow()` result rather than hand-copied, so the
 * bootstrap can never drift out of sync with what the sink inserts (that drift
 * is exactly how `no such column` failures appear after a WorkBuddy update).
 * Types are loose on purpose: the app relaxes/rewrites them when it opens the db.
 *
 * @param db - open sqlite database.
 */
function createIndexSchema(db) {
  const sample = buildSessionRow({ sessionId: 'seed', cwd: 'seed', title: 'seed', at: 0, userId: 'local' });
  const affinity = (value) => (typeof value === 'number' ? 'INTEGER' : 'TEXT');
  const columns = Object.entries(sample).map(([name, value]) => {
    if (name === 'id') return `${name} TEXT PRIMARY KEY`;
    return `${name} ${affinity(value)}`;
  });
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (${columns.join(', ')});`);
  db.exec('CREATE TABLE IF NOT EXISTS workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER);');
}

/**
 * Report whether WorkBuddy history is writable.
 *
 * The index db is what makes an exported session *visible* in the sidebar, so a
 * working db is the ideal case. It is not the only case: on a machine where
 * WorkBuddy is installed but has never run, the projects folder alone is still a
 * legitimate target — the sink creates the db on first write. Treat "folder
 * writable" as available, and keep the db state in the message so the panel can
 * explain what will happen.
 *
 * @returns `{ available, location, error }`.
 */
export async function status(env = process.env) {
  const index = await readIndex(env);
  const root = projectsRoot(env);
  if (index.available) return { available: true, location: root, error: null };

  // No usable database: fall back to whether the target tree can be created.
  let writable = false;
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  if (writable) {
    return {
      available: true,
      location: root,
      error: null,
      note: `尚未找到会话索引（${index.dbPath}），首次导出时会自动创建；如果 WorkBuddy 已安装，建议先启动一次以便会话直接出现在侧边栏。`,
    };
  }
  return {
    available: false,
    location: root,
    error: `目录不可写：${root}。请确认路径存在且当前用户有写权限。`,
  };
}

/** Build a valid `sessions` row matching WorkBuddy's own defaults. */
function buildSessionRow({ sessionId, cwd, title, at, userId, permissionMode }) {
  return {
    id: sessionId,
    cwd,
    user_id: userId,
    title,
    custom_title: null,
    status: 'completed',
    created_at: at,
    updated_at: at,
    deleted_at: null,
    is_playground: 0,
    source_mode: 'craft',
    is_background_automation: null,
    model: 'imported',
    expert_id: null,
    expert_locale: null,
    expert_runtime_identity: null,
    last_activity_at: at,
    expert_marketplace: null,
    // WorkBuddy reads the session's permission level from this column, and a
    // row without it lands on `default`, where every tool call waits for an
    // approval the imported transcript cannot answer — the session then looks
    // broken ("agent commands don't run"). An imported session is meant to be
    // continued, so it defaults to the same level as a normal WorkBuddy session.
    permission_mode: permissionMode ?? 'fullAccess',
    use_sandbox_cli: 1,
    project_id: null,
    mode: 'craft',
    plugin_context_json: null,
    addon_selection: null,
    session_settings: null,
    last_user_prompt_expert_selection: null,
    context_window: null,
    buddy_snapshot_id: null,
    buddy_binding_json: null,
    thought_level: null,
    transport: 'local',
    conversation_origin: 'imported',
    visibility: null,
    group_id: null,
    group_title: null,
    agent_dirty: null,
    agent_dirty_at: null,
    agent_last_synced: null,
    verified_at: null,
    unread: 0,
  };
}

/**
 * Render a neutral conversation as WorkBuddy JSONL rows.
 *
 * @param conversation - neutral conversation.
 * @param options - `{ sessionId, cwd, title, at, flattenTools? }`.
 * @returns row array.
 */
export function buildRows(conversation, options = {}) {
  const sessionId = options.sessionId ?? randomUUID();
  const cwd = options.cwd ?? conversation.cwd ?? '';
  const title = oneLine(options.title ?? conversation.title, '(导入的会话)');
  const at = millis(options.at ?? conversation.createdAt);
  const flattenTools = options.flattenTools === true;

  const rows = [];
  /** The chain head: every row points at the previously written row. */
  let parentId = null;
  const push = (row) => {
    const full = { id: randomUUID(), parentId, ...row };
    rows.push(full);
    parentId = full.id;
    return full;
  };

  push({
    type: 'session-meta',
    sessionId,
    timestamp: at,
    meta: {
      'codebuddy.ai/hostKind': 'unopted',
      importedBy: IMPORT_MARKER,
      'imported.from': conversation.source ?? 'dsh',
      'imported.sourceSessionId': conversation.id ?? null,
      'imported.at': new Date().toISOString(),
    },
  });
  push({ type: 'ai-title', aiTitle: title, sessionId, timestamp: at });

  const notes = [...(conversation.notes ?? [])];
  let flattenedRuns = 0;
  let convertedAsks = 0;

  for (const turn of conversation.turns ?? []) {
    const userText = (turn.user?.content ?? [])
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (userText !== '') {
      push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: userText }],
        sessionId,
        cwd,
        timestamp: millis(turn.at, at),
        _meta: { imported: true },
      });
    }

    for (const run of turn.runs ?? []) {
      const runAt = millis(run.at, at);
      const calls = (run.blocks ?? []).filter((block) => block.type === 'tool-call');
      // Every event of one assistant reply must share one `messageId`:
      // `providers/workbuddy.js` groups a "run" by that key, and an absent key
      // makes it mint a run per event — which inflates the tool count on
      // re-import. One id per run is the contract on both sides.
      const messageId = randomUUID();

      if (flattenTools) {
        // Flat mode: nothing is dropped, but tool calls and results become text
        // so the target conversation carries no foreign call ids.
        const body = flattenRun(run, { includeReasoning: true });
        if (body !== '') {
          push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: body }],
            sessionId,
            cwd,
            timestamp: runAt,
            status: 'completed',
            providerData: { imported: true, model: 'imported', messageId },
            _meta: { imported: true },
          });
          if (calls.length > 0) flattenedRuns += 1;
        }
        continue;
      }

      // Reasoning keeps its own event kind. Folding it into the answer (the
      // previous behaviour) survived a one-way move but broke a round trip:
      // `providers/workbuddy.js` then read it back as ordinary text, so the
      // thinking/answer boundary and the reasoning count were lost. The shape
      // below is copied from real WorkBuddy transcripts (`content` empty,
      // `rawContent[0].type === 'reasoning_text'`).
      const reasoning = (run.blocks ?? [])
        .filter((block) => block.type === 'reasoning')
        .map((block) => block.text)
        .filter((value) => typeof value === 'string' && value.trim() !== '');
      // Trimmed on write to match `providers/workbuddy.js`, which trims when it
      // reads a transcript back. Without this the source keeps trailing blank
      // lines that the reader drops, so a round trip shrank by a few characters
      // per block even though no content was lost.
      const reasoningTextValue = reasoning.join('\n\n').trim();
      if (reasoningTextValue !== '') {
        push({
          type: 'reasoning',
          content: [],
          rawContent: [{ type: 'reasoning_text', text: reasoningTextValue }],
          sessionId,
          cwd,
          timestamp: runAt,
          providerData: { imported: true, model: 'imported', messageId, agent: 'imported' },
          _meta: { imported: true },
        });
      }

      const textValue = (run.blocks ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .join('\n\n')
        .trim();

      // Ask-the-user calls become text instead of a foreign question card; the
      // recorded answers are all the transcript needs to stay readable.
      const askCalls = calls.filter((call) => isAskUserTool(call));
      const workCalls = calls.filter((call) => !isAskUserTool(call));
      const askText = askCalls
        .map((call) => (run.toolResults ?? []).find((entry) => entry.callId === call.id))
        .map((result) => (typeof result?.output === 'string' ? result.output.trim() : ''))
        .filter((value) => value !== '')
        .join('\n');
      if (askCalls.length > 0) convertedAsks += askCalls.length;

      const assistantText = [textValue, askText].filter((value) => value !== '').join('\n\n');

      if (assistantText !== '') {
        push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: assistantText }],
          sessionId,
          cwd,
          timestamp: runAt,
          status: 'completed',
          providerData: { imported: true, model: 'imported', messageId },
          _meta: { imported: true },
        });
      }

      for (const call of workCalls) {
        push({
          type: 'function_call',
          callId: call.id,
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
          sessionId,
          cwd,
          timestamp: runAt,
          providerData: {
            imported: true,
            messageId,
            agent: 'imported',
            argumentsDisplayText: String(call.arguments ?? '').slice(0, 500),
          },
          _meta: { imported: true },
        });
        const result = (run.toolResults ?? []).find((entry) => entry.callId === call.id);
        push({
          type: 'function_call_result',
          callId: call.id,
          name: call.name,
          status: result?.isError === true ? 'error' : 'completed',
          output: { type: 'text', text: result?.output ?? '[结果未记录]' },
          sessionId,
          cwd,
          timestamp: millis(result?.at, runAt),
          providerData: { imported: true, messageId },
          _meta: { imported: true },
        });
      }
    }
  }

  if (flattenedRuns > 0) notes.push(`${flattenedRuns} 段助手输出的工具调用已内联为纯文本（接续友好模式）`);
  if (convertedAsks > 0) notes.push(`${convertedAsks} 次「向用户提问」已转为文本问答（避免在 WorkBuddy 里变成空提问卡片）`);
  return { sessionId, title, cwd, rows, notes };
}

/**
 * Write one conversation into WorkBuddy.
 *
 * @param conversation - neutral conversation.
 * @param options - `{ dryRun?, force?, sessionId?, originId?, cwd?, title?, targetProject?, overwrite?, flattenTools? }`.
 * @returns WriteResult (see `./shared.js`).
 */
export async function write(conversation, options = {}) {
  const env = options.env ?? process.env;
  const index = await readIndex(env);
  const notes = [...(conversation.notes ?? [])];

  const cwd = options.cwd ?? conversation.cwd ?? os.homedir();
  // WorkBuddy's own reader (`providers/workbuddy.js`) only accepts ids that
  // look like `<uuid>` or `agent-<hash>`; anything else is invisible to it no
  // matter how correct the file is. Enforce the same shape here.
  const originId = options.sessionId === undefined ? preferredOriginId(options.originId) : undefined;
  const sessionId = options.sessionId ?? originId ?? derivedSessionId(conversation) ?? randomUUID();
  if (!WORKBUDDY_ID.test(sessionId)) {
    const error = new Error(
      `会话 id 不符合 WorkBuddy 的命名规则（需要 UUID）：${sessionId}。不传 sessionId 会自动生成一个。`,
    );
    error.code = 'bad-id';
    throw error;
  }
  const root = projectsRoot(env);
  // A round trip stays in the folder the session already lives in, so the same
  // id can never appear twice under two projects.
  const project = options.targetProject
    ?? (originId === undefined ? undefined : existingProjectDir(root, sessionId))
    ?? encodeProjectDir(cwd, env);
  if (originId !== undefined) {
    notes.push(`该会话原本就是从 WorkBuddy 导入的，本次写回原会话 ${sessionId}（不新建副本）`);
  }
  const file = path.join(root, project, `${sessionId}.jsonl`);
  const wantsWrite = options.dryRun === false;

  const built = buildRows(conversation, {
    sessionId,
    cwd,
    title: options.title ?? conversation.title,
    at: conversation.createdAt,
    flattenTools: options.flattenTools === true,
  });
  // `buildRows` returns only the notes it added; the caller's notes come from
  // `conversation.notes` already collected above — do not concatenate twice.
  for (const note of built.notes) if (!notes.includes(note)) notes.push(note);

  const exists = fs.existsSync(file);
  const indexed = index.rows.get(sessionId);
  if (options.overwrite === false && (exists || indexed !== undefined)) {
    const error = new Error(`目标位置已存在同名会话（${sessionId}），未允许覆盖`);
    error.code = 'exists';
    throw error;
  }
  if (indexed !== undefined) {
    // Never quietly reuse an id that belongs to a different, real conversation.
    const indexedTitle = typeof indexed.title === 'string' ? indexed.title : '';
    if (indexed.deleted_at !== null && indexed.deleted_at !== undefined) {
      notes.push('该 id 在 WorkBuddy 中曾被删除，本次写入会恢复它');
    } else if (indexedTitle !== '' && indexedTitle !== built.title) {
      notes.push(`该 id 原本属于会话「${indexedTitle}」，本次写入会替换其会话文件`);
    }
  }

  const plan = {
    target: file,
    targetId: sessionId,
    sessionId,
    project,
    rows: built.rows.length,
    messages: built.rows.filter((row) => row.type === 'message').length,
    exists,
    notes,
  };

  if (!wantsWrite) return { ok: true, dryRun: true, mode: exists ? 'overwritten' : 'created', ...plan };

  // Refuse while the app is live: its in-memory session state wins on the next
  // flush and would drop everything we just wrote.
  assertNotRunning(EXE_NAME, { force: options.force === true, label: 'WorkBuddy' });

  // The index is what puts the session in the sidebar. When WorkBuddy has never
  // run there is no db yet, so bootstrap the minimal schema on first write
  // instead of refusing — the transcript alone is invisible to the app.
  let bootstrapped = false;
  if (!index.available) {
    const sqlite = await loadSqlite();
    if (typeof sqlite?.DatabaseSync !== 'function') {
      const error = new Error('找不到 WorkBuddy 会话索引，且当前运行时不提供 node:sqlite，无法创建索引');
      error.code = 'no-index';
      throw error;
    }
    fs.mkdirSync(path.dirname(index.dbPath), { recursive: true });
    const seed = new sqlite.DatabaseSync(index.dbPath);
    try {
      createIndexSchema(seed);
    } finally {
      try {
        seed.close();
      } catch {
        // Never opened / already closed.
      }
    }
    bootstrapped = true;
    notes.push(`首次导出：已创建 WorkBuddy 会话索引（${index.dbPath}）`);
  }

  // 1) transcript first: a stray file is harmless, a row without a file is not.
  const written = atomicWrite(file, toJsonl(built.rows), { backup: exists });
  if (written.strategy !== undefined && written.strategy !== 'rename') {
    notes.push(
      `目标文件被其它程序短暂占用：重试 ${written.retries} 次后已用「${written.strategy}」方式完成写入，内容不受影响`,
    );
  }

  // 2) index row + workspace, in one transaction so a crash cannot leave a
  //    half-registered session behind.
  const sqlite = await loadSqlite();
  if (typeof sqlite?.DatabaseSync !== 'function') {
    throw new Error('当前运行时不提供 node:sqlite，无法写入 WorkBuddy 会话索引');
  }
  const dbBak = bootstrapped ? null : `${index.dbPath}.bak-${backupStamp()}`;
  if (dbBak !== null) fs.copyFileSync(index.dbPath, dbBak);
  const db = new sqlite.DatabaseSync(index.dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    // Keep a level the user picked inside WorkBuddy; only a fresh import (or a
    // row that never had one) gets the full-access default.
    let existingMode = null;
    try {
      const prior = db.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get(sessionId);
      if (typeof prior?.permission_mode === 'string' && prior.permission_mode !== '') existingMode = prior.permission_mode;
    } catch {
      // A schema without the column simply keeps the default.
    }
    const row = buildSessionRow({
      sessionId,
      cwd,
      title: built.title,
      at: millis(conversation.createdAt),
      userId: index.userId,
      permissionMode: existingMode,
    });
    const cols = Object.keys(row);
    db.prepare(
      `INSERT OR REPLACE INTO sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ).run(...Object.values(row));
    db.prepare(
      'INSERT INTO workspaces(path, last_opened_at) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET last_opened_at=excluded.last_opened_at',
    ).run(cwd, Date.now());
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Transaction may already be gone.
    }
    db.close();
    // Restore the transcript so the failure leaves nothing half-written.
    if (written.backupPath !== null && written.backupPath !== undefined) fs.copyFileSync(written.backupPath, file);
    else {
      try {
        fs.unlinkSync(file);
      } catch {
        // Nothing to remove.
      }
    }
    throw new Error(`写入 WorkBuddy 会话索引失败，已回滚：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }

  return {
    ok: true,
    dryRun: false,
    mode: exists ? 'overwritten' : 'created',
    ...plan,
    backupPath: written.backupPath ?? undefined,
    dbBackupPath: dbBak,
    bytes: written.bytes,
    notes,
  };
}
