/**
 * DSH session → neutral `Conversation`.
 *
 * This is the reverse of `writer.js`: it reads a persisted DSH v4 transcript
 * and rebuilds the same neutral shape that import providers produce, so an
 * export sink can consume a DSH session without knowing anything about DSH's
 * event log.
 *
 * Prefers the public harness seams when available:
 *   - `ctx.get('sessions')` — live session objects (correct in-memory state)
 *   - `ctx.get('sessionStore')` / `sessionPersistence.list()` — ids on disk
 * and falls back to reading `~/.dsh/sessions/**\/session.v4.jsonl.zstd`
 * directly (multi-frame zstd) when the seams are absent.
 *
 * Grouping mirrors DSH's own semantics:
 *   turn/start → step/start → user/message → [assistant/message → tool/call →
 *   tool/result]×n → step/end → turn/end
 * One `assistant/message` is one *run*; its tool calls pair with the
 * `tool/result` events that follow it in the same step.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** zstd frame magic (little-endian on disk, read as UInt32BE for scanning). */
const ZSTD_MAGIC_BE = 0x28b52ffd;

/** Maximum characters kept from one tool result. */
const TOOL_RESULT_MAX_CHARS = 20_000;

/** Maximum characters kept from one reasoning block. */
const REASONING_MAX_CHARS = 12_000;

/** Resolve the DSH home directory the way the CLI does. */
export function dshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return configured === '' ? path.join(os.homedir(), '.dsh') : configured;
}

/** The directory holding every persisted session. */
export function sessionsRoot(env = process.env) {
  return path.join(dshHome(env), 'sessions');
}

/**
 * Walk the block structure of one zstd frame to learn its exact length.
 *
 * A truncated tail frame is the classic corruption mode here, and
 * `zstdDecompressSync` happily returns partial output for it — so frame
 * boundaries must be derived from the frame's own block headers rather than
 * from "distance to the next magic number".
 *
 * @param buf - whole file.
 * @param start - offset of the frame magic.
 * @returns byte length of the frame, or null when the frame is incomplete.
 */
function zstdFrameLength(buf, start) {
  let p = start + 4;
  if (p >= buf.length) return null;
  const fhd = buf[p];
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const hasChecksum = (fhd >> 2) & 1;
  const didFlag = fhd & 3;
  p += 1;
  if (!singleSegment) p += 1; // window descriptor
  p += [0, 1, 2, 4][didFlag] ?? 0; // dictionary id
  p += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag] ?? 0; // frame content size
  if (p > buf.length) return null;

  for (;;) {
    if (p + 3 > buf.length) return null;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    p += 3;
    // type 1 = RLE: one content byte regardless of `size`
    p += type === 1 ? 1 : size;
    if (p > buf.length) return null;
    if (last === 1) break;
  }
  if (hasChecksum) p += 4;
  return p <= buf.length ? p - start : null;
}

/**
 * Decode a DSH v4 transcript into its event list.
 * @param file - `session.v4.jsonl.zstd` path.
 * @returns `{ events, truncated }`; unreadable frames are counted, not thrown.
 */
export function readDshEvents(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (buf.readUInt32BE(i) === ZSTD_MAGIC_BE) starts.push(i);
  }
  const events = [];
  let truncated = 0;
  for (const start of starts) {
    const length = zstdFrameLength(buf, start);
    if (length === null) {
      truncated += 1;
      continue;
    }
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(start, start + length)).toString('utf8');
    } catch {
      truncated += 1;
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // A single unparseable line must not discard the whole frame.
      }
    }
  }
  return { events, truncated };
}

/** Concatenate the text blocks of a content array. */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block.text === 'string' && block.type !== 'tool-call')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Truncate with a marker, idempotently.
 *
 * The export direction owns its own copy rather than sharing the import side's
 * `clamp`: import behaviour is intentionally left untouched, and this direction
 * needs one rule the import side does not — never truncate text that is already
 * truncated. A round trip otherwise re-cuts the same text against the same
 * limit on every hop and appends another marker each time.
 *
 * @param text - source text.
 * @param max - maximum characters kept.
 * @param label - direction label used in the marker.
 * @returns the source text or its truncated form.
 */
const TRUNCATION_PATTERN = /\n…\[truncated \d+ characters by [^\]]+\]$/;

function clampText(text, max, label) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= max) return value;
  if (TRUNCATION_PATTERN.test(value)) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} characters by ${label}]`;
}

/**
 * Locate every persisted session on disk.
 * @returns `[{ id, cwd, workspace, file }]`, newest file first.
 */
export function scanDshSessions(env = process.env) {
  const root = sessionsRoot(env);
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const workspace of safeReaddir(root)) {
    const workspaceDir = path.join(root, workspace);
    if (!isDir(workspaceDir)) continue;
    for (const sessionId of safeReaddir(workspaceDir)) {
      const file = path.join(workspaceDir, sessionId, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      found.push({ id: sessionId, workspace, file, mtime: stat.mtimeMs, size: stat.size });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

/** Directory listing that tolerates permission errors and races. */
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Stat-free directory probe. */
function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Convert decoded DSH events into a neutral `Conversation`.
 *
 * @param events - decoded DSH event list (any order; sorted by `seq`).
 * @param meta - `{ id, file?, cwd?, title? }` identity fallbacks.
 * @returns neutral conversation, or null when the log holds no user turns.
 */
export function eventsToConversation(events, meta = {}) {
  const ordered = events
    .filter((event) => typeof event.seq === 'number')
    .slice()
    .sort((a, b) => a.seq - b.seq);

  const header = events.find((event) => event.type === 'session') ?? {};
  const titleEvent = ordered.filter((event) => event.type === 'session/title').pop();

  /** run object being filled: one per assistant/message */
  let currentRun = null;
  /** tool calls awaiting their result, by callId */
  const pending = new Map();
  /**
   * Which run introduced each tool-call id. DSH emits the `tool/result` for a
   * call while a *later* run may already be open (parallel calls, sub-agent
   * rounds, compaction replays), so the result must be attached to the run
   * that owns the call — not to whatever run happens to be current.
   */
  const callOwner = new Map();
  const turns = [];
  let currentTurn = null;
  let lastTime = 0;

  const ensureTurn = (at) => {
    if (currentTurn !== null) return currentTurn;
    currentTurn = { at, user: null, runs: [] };
    turns.push(currentTurn);
    return currentTurn;
  };

  for (const event of ordered) {
    const data = event.data ?? {};
    const at = typeof event.time === 'number' ? event.time : lastTime;
    lastTime = at;

    switch (event.type) {
      case 'turn/start': {
        // Do not open a turn here: DSH emits `turn/start` and only *later* the
        // `user/message` (with system/header events in between). Opening a turn
        // eagerly creates an empty turn whenever the prompt never arrives
        // (cancelled runs, tool-only continuations).
        // A new turn also means the previous run cannot receive more results.
        currentTurn = null;
        currentRun = null;
        // `pending` holds call metadata for pairing; `callOwner` must survive a
        // turn boundary so a late result still finds the run that issued it.
        pending.clear();
        break;
      }
      case 'user/message': {
        // Only real user input; tool-result replays and inbox injections are not
        // part of the conversation surface an agent should re-import.
        const kind = data.source?.kind;
        if (typeof kind === 'string' && kind !== 'user') break;
        const text = textOf(data.content);
        if (text === '') break;
        // A `turn/start` opens the turn; the first real user message fills it.
        // Only a *second* user message inside one turn (a mid-turn steering
        // message) opens a new turn, keeping prompt order intact.
        if (currentTurn === null) {
          ensureTurn(at);
        } else if (currentTurn.user !== null) {
          currentTurn = { at, user: null, runs: [] };
          turns.push(currentTurn);
        }
        currentTurn.user = { content: [{ type: 'text', text }] };
        currentRun = null;
        break;
      }
      case 'assistant/message': {
        const content = data.message?.content ?? [];
        const blocks = [];
        for (const block of content) {
          if (!block) continue;
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            blocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'reasoning') {
            const text = clampText(block.text ?? '', REASONING_MAX_CHARS, 'dsh-exporter');
            if (text.trim() !== '') blocks.push({ type: 'reasoning', text });
          } else if (block.type === 'tool-call') {
            blocks.push({
              type: 'tool-call',
              id: typeof block.id === 'string' ? block.id : `call-${blocks.length}`,
              name: typeof block.name === 'string' ? block.name : 'tool',
              arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
            });
          }
        }
        if (blocks.length === 0) break;
        const turn = ensureTurn(at);
        const run = { at, blocks, toolResults: [] };
        currentRun = run;
        turn.runs.push(run);
        for (const block of blocks) {
          if (block.type === 'tool-call') callOwner.set(block.id, run);
        }
        break;
      }
      case 'tool/call': {
        // `tool/call` opens the lifecycle; remember its identity so the result
        // can be paired even when the assistant block id was normalized.
        const callId = data.callId ?? data.message?.toolCallId;
        if (typeof callId === 'string') {
          pending.set(callId, {
            callId,
            name: data.name ?? data.message?.name ?? 'tool',
            arguments: data.arguments ?? '{}',
          });
        }
        break;
      }
      case 'tool/result': {
        const callId = data.message?.toolCallId ?? data.toolCallId;
        const known = typeof callId === 'string' ? pending.get(callId) : undefined;
        const output = textOf(data.message?.content ?? []);
        const entry = {
          callId: callId ?? known?.callId ?? `call-result-${turns.length}-${currentRun?.toolResults.length ?? 0}`,
          name: known?.name ?? data.name ?? 'tool',
          arguments: known?.arguments ?? '{}',
          output: clampText(output === '' ? '[没有输出]' : output, TOOL_RESULT_MAX_CHARS, 'dsh-exporter'),
          isError: data.message?.isError === true,
          at,
        };
        const turn = ensureTurn(at);
        // Prefer the run that actually issued the call. Only fall back to the
        // current run when the call had no assistant block at all (a tool round
        // DSH recorded without an accompanying message).
        let target = typeof callId === 'string' ? callOwner.get(callId) : undefined;
        if (target === undefined) {
          if (currentRun === null) {
            currentRun = { at, blocks: [], toolResults: [] };
            turn.runs.push(currentRun);
          }
          target = currentRun;
        }
        // A call must not collect two results (DSH can re-emit a result after a
        // compaction replay); the second copy would double-count the call.
        if (!target.toolResults.some((existing) => existing.callId === entry.callId)) {
          target.toolResults.push(entry);
        }
        if (typeof callId === 'string') pending.delete(callId);
        break;
      }
      case 'compaction/summary': {
        // Context was compacted: keep the summary as a user-visible turn so the
        // exported conversation does not silently lose everything it replaced.
        const text = textOf(data.summary);
        if (text === '') break;
        turns.push({ at, user: { content: [{ type: 'text', text: `[上下文压缩摘要]\n${text}` }] }, runs: [] });
        currentTurn = turns[turns.length - 1];
        currentRun = null;
        break;
      }
      default:
        break;
    }
  }

  // Drop turns that ended up completely empty (tool-only chrome events).
  const kept = turns.filter(
    (turn) => turn.user !== null || turn.runs.some((run) => run.blocks.length > 0 || run.toolResults.length > 0),
  );
  if (kept.length === 0) return null;

  // A turn with output but no prompt is a continuation of the previous exchange
  // (DSH restarts a turn for tool-only rounds). Fold it back so an exported
  // conversation shows one prompt followed by its full answer, not a prompt-
  // less turn the target agent would render as an orphan block.
  const merged = [];
  let continuations = 0;
  for (const turn of kept) {
    if (turn.user === null && merged.length > 0) {
      merged[merged.length - 1].runs.push(...turn.runs);
      continuations += 1;
      continue;
    }
    merged.push(turn);
  }

  let repaired = 0;
  // Every tool-call block needs exactly one matching result: the DSH writer
  // relies on it, and so does the resumed conversation the target builds.
  const notes = [];
  if (continuations > 0) notes.push(`合并了 ${continuations} 段无提问的续跑回合到上一个提问下`);

  // Tool ids must be unique across the whole conversation — every downstream
  // writer keys results by that id, so a duplicate would pair a result with the
  // wrong call. The repair pass above keys globally too, so it cannot introduce
  // duplicates on a clean session; this stays as a guard for replayed or
  // hand-edited transcripts. Renames are recorded globally rather than per run,
  // because a result is allowed to live in a different run than its call.
  const usedIds = new Set();
  const renamedIds = new Map();
  let renamed = 0;
  for (const turn of merged) {
    for (const run of turn.runs) {
      for (const block of run.blocks) {
        if (block.type !== 'tool-call') continue;
        const original = block.id;
        let id = original;
        let suffix = 2;
        while (usedIds.has(id)) {
          id = `${original}~${suffix}`;
          suffix += 1;
        }
        usedIds.add(id);
        if (id !== original) {
          renamedIds.set(original, id);
          block.id = id;
          renamed += 1;
        }
      }
    }
  }
  if (renamedIds.size > 0) {
    for (const turn of merged) {
      for (const run of turn.runs) {
        for (const result of run.toolResults) {
          const renamedTo = renamedIds.get(result.callId);
          if (renamedTo !== undefined) result.callId = renamedTo;
        }
      }
    }
  }
  if (renamed > 0) notes.push(`重命名了 ${renamed} 个重复使用的工具调用 id（原会话中同一 id 出现多次）`);

  // Repair pass. Both directions are keyed by call id across the *whole*
  // conversation, because a result may live in a different run than its call
  // (parallel calls, sub-agent rounds). A missing pair is a data gap worth
  // noting; it must never invent a second block for a call that already has one.
  const allCallIds = new Set();
  for (const turn of merged) {
    for (const run of turn.runs) {
      for (const block of run.blocks) {
        if (block.type === 'tool-call') allCallIds.add(block.id);
      }
    }
  }
  const allResultIds = new Set();
  for (const turn of merged) {
    for (const run of turn.runs) {
      for (const result of run.toolResults) allResultIds.add(result.callId);
    }
  }

  for (const turn of merged) {
    for (const run of turn.runs) {
      for (const block of run.blocks) {
        if (block.type !== 'tool-call') continue;
        if (allResultIds.has(block.id)) continue;
        run.toolResults.push({
          callId: block.id,
          name: block.name,
          arguments: block.arguments,
          output: '[结果未记录]',
          isError: true,
          at: run.at,
        });
        allResultIds.add(block.id);
        repaired += 1;
      }
      // Only synthesize a block for a result whose call is missing everywhere;
      // `allCallIds` is global, so a paired call is never duplicated.
      for (const result of run.toolResults) {
        if (allCallIds.has(result.callId)) continue;
        run.blocks.push({ type: 'tool-call', id: result.callId, name: result.name, arguments: result.arguments });
        allCallIds.add(result.callId);
        repaired += 1;
      }
    }
  }
  if (repaired > 0) notes.push(`补齐了 ${repaired} 处工具调用/结果配对（原会话中有缺失）`);

  const stamps = merged.map((turn) => turn.at).filter((at) => Number.isFinite(at) && at > 0);
  return {
    source: 'dsh',
    id: meta.id ?? header.id ?? 'session-unknown',
    title: meta.title ?? titleEvent?.data?.title ?? '(无标题会话)',
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : Math.min(...stamps, Date.now()),
    updatedAt: Math.max(...stamps, typeof header.createdAt === 'number' ? header.createdAt : 0),
    cwd: meta.cwd ?? header.cwd ?? null,
    messageCount: merged.length,
    // A delegated run is not a session the DSH page lists on its own: it is
    // reachable only through its parent's row. The durable header is the
    // authority for this (`origin: 'subagent'` + `parentSession`), which makes
    // the export list filterable without trusting the browser feed alone.
    origin: typeof header.origin === 'string' ? header.origin : undefined,
    parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
    turns: merged,
    notes,
  };
}

/**
 * Load one persisted DSH session by id.
 * @param sessionId - session id (with or without the `session-` prefix).
 * @param options - `{ env?, file? }`.
 * @returns neutral conversation.
 */
export function loadDshConversation(sessionId, options = {}) {
  const wanted = typeof sessionId === 'string' ? sessionId : '';
  if (wanted === '') throw new Error('缺少会话 id');
  const all = scanDshSessions(options.env);
  const hit =
    (options.file !== undefined ? all.find((entry) => entry.file === options.file) : undefined) ??
    all.find((entry) => entry.id === wanted) ??
    all.find((entry) => entry.id === `session-${wanted}`) ??
    all.find((entry) => entry.id.includes(wanted));
  if (hit === undefined) throw new Error(`找不到 DSH 会话：${wanted}`);
  const { events, truncated } = readDshEvents(hit.file);
  const conversation = eventsToConversation(events, { id: hit.id, file: hit.file });
  if (conversation === null) throw new Error(`DSH 会话没有可导出的内容：${wanted}`);
  if (truncated > 0) {
    conversation.notes = [
      ...(conversation.notes ?? []),
      `源会话有 ${truncated} 个损坏/截断的 zstd 帧被跳过（这之前的内容完整）`,
    ];
  }
  conversation.file = hit.file;
  conversation.workspace = hit.workspace;
  return conversation;
}

/**
 * List persisted DSH sessions with lightweight metadata for the export panel.
 * @param options - `{ env?, files? }`; `files` is a set of transcript paths to
 *   restrict the listing to (the panel passes the ones the DSH page shows, so
 *   a session nobody can see is never read at all).
 * @returns `[{ id, title, cwd, updatedAt, messageCount, workspace }]`.
 */
export function listDshConversations(options = {}) {
  const rows = [];
  const allow = options.files instanceof Set ? options.files : null;
  for (const entry of scanDshSessions(options.env)) {
    if (allow !== null && !allow.has(entry.file)) continue;
    try {
      const conversation = loadDshConversation(entry.id, { ...options, file: entry.file });
      rows.push({
        id: conversation.id,
        title: conversation.title,
        cwd: conversation.cwd,
        updatedAt: conversation.updatedAt,
        createdAt: conversation.createdAt,
        messageCount: conversation.messageCount,
        workspace: entry.workspace,
        file: entry.file,
        // `'subagent'` marks a delegated run; the export list drops those.
        origin: conversation.origin,
        parentSession: conversation.parentSession,
      });
    } catch {
      // An unreadable session must not hide the rest of the list.
    }
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}
