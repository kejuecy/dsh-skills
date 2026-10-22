/**
 * WorkBuddy (字节跳动 AI coding agent, codebuddy) provider.
 *
 * WorkBuddy stores every local agent conversation as one append-only JSONL
 * transcript per session under `~/.workbuddy/projects/<cwd-encoded>/`:
 *
 *   <sessionId>.jsonl      - event log (messages, reasoning, tool calls, ...)
 *   <sessionId>.meta.json  - conversation metadata (cwd, model, subagents)
 *   subagents/<id>.jsonl   - per-subagent side logs (subagents/log.json with cursor)
 *
 * The .jsonl is a flat event order (not a strict tree): each event carries
 * `id` and, when it belongs to an earlier event, `parentId`. Relevant event
 * types observed on Windows:
 *
 *   - {type:'message',  role:'user',      content:[{type:'input_text', text}]}
 *   - {type:'message',  role:'assistant', content:[{type:'output_text', text}]}
 *   - {type:'reasoning',  rawContent:[...]  or content:[...]}   (thinking)
 *   - {type:'function_call',  callId, name, arguments}
 *       - payload may be at top level or inside `message` ({callId,name,arguments})
 *   - {type:'function_call_result', name, callId, status, output}
 *       - payload may be at top level or inside `message`
 *   - {type:'ai-title', aiTitle}           -> conversation title
 *   - {type:'file-history-snapshot', ...}  -> noise, ignored
 *   - {type:'assistant', content or message} (older codebuddy schema, text/tool)
 *
 * A "run" is one assistant turn. All reasoning + tool calls + text produced in
 * one assistant response share the same source `providerData.messageId` /
 * `conversationRequestId`; we use the nearest `messageId` as the run's group
 * key so reasoning, tool-call and result events coalesce into one run.
 *
 * Only `node:` builtins are imported so this file can be dropped into
 * `dsh-agent-session-sync/lib/host/providers/workbuddy.js` unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { cleanTitle, clamp, cwdLabel, toMillis, textContent } from './shared.js';
import { queryJsonReadOnly } from '../sqlite.js';

/** Stable provider id (lowercase, no colon). */
export const id = 'workbuddy';
/** Display label for the source picker. */
export const label = 'WorkBuddy';
/** One-line description for the source picker. */
export const description = 'WorkBuddy 本地 JSONL 会话（~/.workbuddy/projects，只读）';

/** Maximum characters kept from one tool result. */
const TOOL_RESULT_MAX_CHARS = 20_000;
/** Maximum characters kept from one reasoning block. */
const REASONING_MAX_CHARS = 12_000;
/** Per-conversation read budget. */
const LOAD_BUDGET_MS = 240_000;
/** Marker used in truncated text. */
const TRUNCATION_LABEL = 'WorkBuddy importer';

const HOME = os.homedir();

/** The project root WorkBuddy writes transcripts under. */
function dataRoot(env = process.env) {
  const override = env.WORKBUDDY_HOME;
  if (typeof override === 'string' && override.trim() !== '' && path.isAbsolute(override)) return override;
  return path.join(HOME, '.workbuddy', 'projects');
}

/** Candidate root(s) reported in `status().location`. */
function dataRoots(env = process.env) {
  return [dataRoot(env)];
}

/**
 * WorkBuddy's session index database (a sibling of the `projects` folder).
 *
 * The app never deletes transcripts from disk: deleting a conversation only
 * stamps `sessions.deleted_at`, which makes the JSONL file an invisible orphan.
 * Reading this database is the only way to honour a user's deletion.
 */
function databasePath(env = process.env) {
  const override = env.WORKBUDDY_HOME;
  if (typeof override === 'string' && override.trim() !== '' && path.isAbsolute(override)) {
    // `WORKBUDDY_HOME` names the projects root; the database sits beside it.
    return path.join(path.dirname(override), 'workbuddy.db');
  }
  return path.join(HOME, '.workbuddy', 'workbuddy.db');
}

/**
 * The session index: every conversation WorkBuddy itself knows about.
 *
 * WorkBuddy treats the JSONL transcripts as an append-only log — deleting a
 * conversation only stamps `sessions.deleted_at`, and sub-agent runs
 * (`agent-<hash>.jsonl`) never get a row at all. Reading this index is therefore
 * the only faithful way to know what the app's UI would show.
 *
 * @returns { known: Map<id, {title, cwd, deleted, updatedAt}>, available: boolean }
 *   `known` is empty and `available` false when the index cannot be read.
 */
async function sessionIndex(env = process.env) {
  const dbPath = databasePath(env);
  const known = new Map();
  if (!fs.existsSync(dbPath)) return { known, available: false };
  try {
    const rows = await queryJsonReadOnly(
      dbPath,
      'SELECT id, title, cwd, deleted_at, updated_at FROM sessions',
    );
    for (const row of rows) {
      if (typeof row.id !== 'string') continue;
      known.set(row.id, {
        title: typeof row.title === 'string' ? row.title : '',
        cwd: typeof row.cwd === 'string' ? row.cwd : null,
        deleted: row.deleted_at !== null && row.deleted_at !== undefined,
        updatedAt: Number.isFinite(row.updated_at) ? row.updated_at : 0,
      });
    }
    return { known, available: true };
  } catch {
    // Index unavailable: fall back to the transcript scan (no deletion info).
    return { known, available: false };
  }
}

/**
 * Read a single event line into a plain object (never throws; a corrupt line
 * is returned as `null` and the count tracked by the caller).
 */
function parseEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Wrapper tags WorkBuddy injects around a user turn.
 *
 * Measured from real transcripts: these are the only tags that wrap injected
 * context rather than user content. Anything outside this list is treated as
 * text and preserved verbatim.
 */
const INJECTED_TAGS = [
  'system-reminder',
  'craft_mode',
  'current_time',
  'user_info',
  'identity_context',
  'additional_data',
  'project_context',
  'project_layout',
  'product_identity',
  'connector-status',
  'current-expert',
  'expert_selection',
  'automation_system_reminder',
  'memory_and_skills_reminder',
  'previous_user_message',
  'previous_assistant_message',
  'previous_tool_call',
  'teammate-message',
  'conversation_history_summary',
];

/**
 * Text payload of a user message. WorkBuddy wraps the real user prompt inside
 * a big injected `<system-reminder ...>...</system-reminder>` blob (context,
 * identity files, craft_mode, time, memory reminders). The genuine user
 * message is commonly the `<user_query>...</user_query>` tag; when absent we
 * strip every injected block and keep whatever plain text remains, so a turn
 * with only injected context (no real prompt) collapses to empty.
 */
function userText(event) {
  const parts = Array.isArray(event.content) ? event.content : [];
  const text = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('\n');
  if (text.trim() === '') return '';

  // Prefer the explicit <user_query> tag when present. Automation transcripts
  // nest them: an outer unclosed `<user_query>` holds the run-book, and the real
  // task sits in an inner block that shares the single closing tag, so take the
  // innermost (last) opening tag rather than the first match.
  const lastOpen = text.lastIndexOf('<user_query>');
  if (lastOpen !== -1) {
    const body = text.slice(lastOpen + '<user_query>'.length);
    const close = body.indexOf('</user_query>');
    const query = (close === -1 ? body : body.slice(0, close)).trim();
    if (query !== '' && !/^\.+$/.test(query) && !/You MUST follow these steps in order/.test(query)) return query;
  }
  const queryMatch = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (queryMatch && queryMatch[1].trim() !== '' && !/You MUST follow these steps in order/.test(queryMatch[1])) {
    return queryMatch[1].trim();
  }

  // Otherwise drop injected context blocks.
  //
  // Only known wrappers are stripped. A catch-all like `/<[a-z_][^>]*>/g`
  // (what this used to be) also deletes genuine user content: real transcripts
  // here contain WXML such as `<view>` (361 occurrences), `<text>` (144) and
  // `<div>` (9), plus placeholder text like `` `<id>.json` ``. Those all match a
  // lowercase tag pattern, so a round trip silently ate them.
  let cleaned = text;
  for (const tag of INJECTED_TAGS) {
    const open = `<${tag}(?:\\s[^>]*)?>`;
    cleaned = cleaned
      .replace(new RegExp(`${open}[\\s\\S]*?</${tag}>`, 'g'), '')
      .replace(new RegExp(`</?${tag}(?:\\s[^>]*)?/?>`, 'g'), '');
  }
  return cleaned.trim();
}

/**
 * Best-effort real project directory for one event stream.
 *
 * Precedence: an explicit `cwd` field on any event (already an absolute path),
 * then the `Workspace Folder:` hint baked into `<user_info>`, then an
 * absolute path recovered from the encoded project folder name.
 * @param events - parsed events in transcript order.
 * @param projectDir - absolute path of the `<encoded-cwd>` project folder.
 * @returns absolute path or null.
 */
function resolveCwd(events, projectDir) {
  for (const event of events) {
    if (typeof event.cwd === 'string' && path.isAbsolute(event.cwd.trim())) return event.cwd.trim();
  }
  for (const event of events) {
    if (event.type !== 'message' || event.role !== 'user') continue;
    const parts = Array.isArray(event.content) ? event.content : [];
    const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n');
    const match = text.match(/Workspace Folder:\s*([^\n<]+)/);
    if (match === null) continue;
    const candidate = match[1].trim();
    if (path.isAbsolute(candidate)) return candidate;
  }
  return importCwdFromProjectDir(projectDir);
}

/**
 * Shorten a long user prompt into a title-sized line: first meaningful
 * sentence, never the automation run-book or an injected tag.
 * @param text - extracted user text.
 * @returns a compact title candidate ('' when nothing usable).
 */
function titleFromText(text) {
  if (typeof text !== 'string') return '';
  // Cut at the first line break / sentence end BEFORE collapsing whitespace,
  // otherwise a multi-line automation prompt becomes one long pseudo-sentence.
  const head = text.trim().split(/\r?\n/)[0] ?? '';
  let line = head.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const stop = line.search(/[。！？;]|(?:\.\s)/);
  if (stop !== -1) line = line.slice(0, stop);
  line = line.trim();
  // Keep the title short enough for one list row.
  if (line.length > 40) line = line.slice(0, 40).trim();
  return line;
}

/** Text payload of an assistant message. */
function assistantText(event) {
  const collections = [];
  if (Array.isArray(event.content)) collections.push(event.content);
  if (event.message && Array.isArray(event.message.content)) collections.push(event.message.content);
  const texts = [];
  for (const collection of collections) {
    for (const part of collection) {
      const t = typeof part?.text === 'string' ? part.text : '';
      if (t.trim() !== '') texts.push(t);
    }
  }
  return texts.join('\n').trim();
}

/** Reasoning text (either `rawContent` blocks or `content` blocks). */
function reasoningText(event) {
  const candidates = [
    ...(Array.isArray(event.rawContent) ? event.rawContent : []),
    ...(Array.isArray(event.content) ? event.content : []),
  ];
  const texts = candidates
    .map((c) => (typeof c?.text === 'string' ? c.text : ''))
    .filter((t) => t.trim() !== '');
  return texts.join('\n').trim();
}

/**
 * Extract the tool call fields from a `function_call` event. The payload can
 * live at the top level or nested under `message`.
 */
function extractToolCall(event) {
  const root = event.message && typeof event.message === 'object' ? event.message : event;
  const callId = root.callId ?? root.id ?? null;
  const name = root.name ?? '';
  const argumentsRaw =
    typeof root.arguments === 'string'
      ? root.arguments
      : typeof root.arguments === 'object'
        ? JSON.stringify(root.arguments)
        : '';
  if (!callId || !name) return null;
  return { callId, name, arguments: argumentsRaw, at: toMillis(event.timestamp) };
}

/** Extract the tool result fields from a `function_call_result` event. */
function extractToolResult(event) {
  const root = event.message && typeof event.message === 'object' ? event.message : event;
  const callId = root.callId ?? root.id ?? null;
  if (!callId) return null;
  const name = root.name ?? '';
  const argumentsRaw =
    typeof root.arguments === 'string'
      ? root.arguments
      : typeof root.arguments === 'object'
        ? JSON.stringify(root.arguments)
        : '';
  let output = '';
  let isError = false;
  if (typeof root.output === 'string') {
    output = root.output;
    isError = /(error|failed|exception)/i.test(output.slice(0, 2000));
  } else if (root.output && typeof root.output === 'object') {
    if (typeof root.output.text === 'string') output = root.output.text;
    else if (root.output.type === 'text' && typeof root.output.text === 'string') output = root.output.text;
    else {
      try {
        output = JSON.stringify(root.output);
      } catch {
        output = '';
      }
    }
    const state = event.status ?? root.status;
    if (state === 'error' || state === 'failed') isError = true;
  }
  if (event.status === 'error' || event.status === 'failed') isError = true;
  return { callId, name, arguments: argumentsRaw, output, isError, at: toMillis(event.timestamp) };
}

/** The run group key for an event (closest ancestor `messageId`). */
function runKeyOf(event) {
  if (typeof event.providerData?.messageId === 'string') return event.providerData.messageId;
  if (typeof event.message?.providerData?.messageId === 'string') return event.message.providerData.messageId;
  return `$${event.id ?? event.timestamp ?? Math.random()}`;
}

/** First user text across the turns (used as the fallback title). */
function firstUserText(turns) {
  for (const turn of turns) {
    if (turn.user !== null && turn.user.content && turn.user.content.length > 0) {
      return turn.user.content.map((c) => c.text ?? '').join(' ').trim();
    }
  }
  return '';
}

/**
 * Reconstruct the neutral `Conversation` from one WorkBuddy session transcript.
 * @param filePath - session .jsonl path.
 * @param meta - parsed `.meta.json` (may be null).
 * @returns Promise<Conversation> (see shared.js for the shape).
 */
async function loadFileToConversation(filePath, meta) {
  const startedAt = Date.now();
  const events = [];
  const byId = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const raw of rl) {
    const event = parseEvent(raw);
    if (event === null) continue;
    if (typeof event.id === 'string') byId.set(event.id, event);
    events.push(event);
    if (Date.now() - startedAt > LOAD_BUDGET_MS) break;
  }
  rl.close();

  // ---- First pass: collect metadata -------------------------------------
  let aiTitle = '';
  let firstUser = null;
  const seenUniqueToolIds = new Set();

  for (const event of events) {
    if (event.type === 'ai-title' && typeof event.aiTitle === 'string' && event.aiTitle.trim() !== '') {
      aiTitle = event.aiTitle;
    }
    if (firstUser === null && event.type === 'message' && event.role === 'user') {
      const text = userText(event);
      if (text.trim() !== '') firstUser = text;
    }
  }

  // ---- Second pass: build turns -----------------------------------------
  // A turn opens on a user event. Every assistant event that arrives until the
  // next user belongs to runs of the current turn. A "run" is one assistant
  // reply: multiple events (reasoning text, then tool calls, then tool results,
  // then final text) coalesce into one run keyed by `providerData.messageId`.
  const turns = [];
  let current = null;
  /** runKey -> run object (the run is already referenced by `current.runs`). */
  const openRuns = new Map();

  for (const event of events) {
    if (event.type === 'ai-title' || event.type === 'file-history-snapshot') continue;

    if (event.type === 'message' && event.role === 'user') {
      const text = userText(event);
      if (current !== null) turns.push(current);
      openRuns.clear();
      if (text.trim() !== '') {
        current = {
          at: toMillis(event.timestamp),
          user: { content: textContent(text) },
          runs: [],
        };
      } else {
        current = null; // context-reminder-only user blob; skip
      }
      continue;
    }

    if (current === null) continue; // events before the first real user message

    const ts = toMillis(event.timestamp);

    if (event.type === 'message' && event.role === 'assistant') {
      const key = runKeyOf(event);
      let run = openRuns.get(key);
      if (!run) {
        run = { at: ts, blocks: [], toolResults: [], byCallId: new Map(), latestTs: ts };
        openRuns.set(key, run);
        current.runs.push(run);
      }
      const text = assistantText(event);
      if (text.trim() !== '' && !run.blocks.some((b) => b.type === 'text')) {
        run.blocks.push({ type: 'text', text: clamp(text, TOOL_RESULT_MAX_CHARS, TRUNCATION_LABEL) });
      }
      run.latestTs = Math.max(run.latestTs, ts);
      continue;
    }

    if (event.type === 'reasoning') {
      const key = runKeyOf(event);
      let run = openRuns.get(key);
      if (!run) {
        run = { at: ts, blocks: [], toolResults: [], byCallId: new Map(), latestTs: ts };
        openRuns.set(key, run);
        current.runs.push(run);
      }
      const text = reasoningText(event);
      if (text.trim() !== '' && !run.blocks.some((b) => b.type === 'reasoning')) {
        run.blocks.push({ type: 'reasoning', text: clamp(text, REASONING_MAX_CHARS, TRUNCATION_LABEL) });
      }
      run.latestTs = Math.max(run.latestTs, ts);
      continue;
    }

    if (event.type === 'function_call') {
      const tool = extractToolCall(event);
      if (!tool) continue;
      const key = runKeyOf(event);
      let run = openRuns.get(key);
      if (!run) {
        run = { at: ts, blocks: [], toolResults: [], byCallId: new Map(), latestTs: ts };
        openRuns.set(key, run);
        current.runs.push(run);
      }
      // Deduplicate tool-call ids within the whole conversation (invariant 1).
      let uniqueId = tool.callId;
      let suffix = 1;
      while (seenUniqueToolIds.has(uniqueId)) {
        uniqueId = `${tool.callId}~${suffix++}`;
      }
      seenUniqueToolIds.add(uniqueId);
      run.blocks.push({ type: 'tool-call', id: uniqueId, name: tool.name, arguments: tool.arguments });
      run.toolResults.push({ callId: uniqueId, name: tool.name, arguments: tool.arguments, output: '', isError: false, at: ts });
      run.byCallId.set(uniqueId, run.toolResults.length - 1);
      run.latestTs = Math.max(run.latestTs, ts);
      continue;
    }

    if (event.type === 'function_call_result') {
      const result = extractToolResult(event);
      if (!result) continue;
      const key = runKeyOf(event);
      let run = openRuns.get(key);
      if (!run) {
        run = { at: ts, blocks: [], toolResults: [], byCallId: new Map(), latestTs: ts };
        openRuns.set(key, run);
        current.runs.push(run);
      }
      // Match against an open tool-call in this run; if absent, synthesize one.
      const idx = run.byCallId.get(result.callId);
      if (idx !== undefined) {
        const entry = run.toolResults[idx];
        entry.output = clamp(result.output, TOOL_RESULT_MAX_CHARS, TRUNCATION_LABEL);
        entry.isError = result.isError || entry.isError;
        entry.at = ts;
      } else {
        let uniqueId = result.callId;
        let suffix = 1;
        while (seenUniqueToolIds.has(uniqueId)) uniqueId = `${result.callId}~${suffix++}`;
        seenUniqueToolIds.add(uniqueId);
        run.blocks.push({ type: 'tool-call', id: uniqueId, name: result.name, arguments: result.arguments });
        run.toolResults.push({
          callId: uniqueId,
          name: result.name,
          arguments: result.arguments,
          output: clamp(result.output, TOOL_RESULT_MAX_CHARS, TRUNCATION_LABEL),
          isError: result.isError,
          at: ts,
        });
        run.byCallId.set(uniqueId, run.toolResults.length - 1);
      }
      run.latestTs = Math.max(run.latestTs, ts);
      continue;
    }

    // Older codebuddy `assistant` schema (text + tool blocks inline).
    if (event.type === 'assistant') {
      const key = runKeyOf(event);
      let run = openRuns.get(key);
      if (!run) {
        run = { at: ts, blocks: [], toolResults: [], byCallId: new Map(), latestTs: ts };
        openRuns.set(key, run);
        current.runs.push(run);
      }
      const payload = event.message && typeof event.message === 'object' ? event.message : event;
      const content = Array.isArray(payload.content) ? payload.content : [];
      for (const part of content) {
        if (part?.type === 'text') {
          if (!run.blocks.some((b) => b.type === 'text')) {
            run.blocks.push({ type: 'text', text: clamp(part.text, TOOL_RESULT_MAX_CHARS, TRUNCATION_LABEL) });
          }
        } else if (part?.type === 'tool_call') {
          const callId = part.id ?? `assist-${Math.random().toString(36).slice(2)}`;
          let uniqueId = callId;
          let suffix = 1;
          while (seenUniqueToolIds.has(uniqueId)) uniqueId = `${callId}~${suffix++}`;
          seenUniqueToolIds.add(uniqueId);
          const args =
            typeof part.arguments === 'string'
              ? part.arguments
              : typeof part.arguments === 'object'
                ? JSON.stringify(part.arguments)
                : '';
          const name = part.name ?? 'tool';
          run.blocks.push({ type: 'tool-call', id: uniqueId, name, arguments: args });
          run.toolResults.push({ callId: uniqueId, name, arguments: args, output: '', isError: false, at: ts });
          run.byCallId.set(uniqueId, run.toolResults.length - 1);
        }
      }
      run.latestTs = Math.max(run.latestTs, ts);
      continue;
    }
  }

  if (current !== null) turns.push(current);

  // Pull results that arrived as function_call_result events AFTER their text
  // already set blocks — the run object is shared so blocks/results stay paired.
  // Also drop any run with no blocks and no results.
  for (const turn of turns) {
    turn.runs = turn.runs.filter((r) => r.blocks.length > 0 || r.toolResults.length > 0);
  }

  // ---- Assemble Conversation --------------------------------------------
  const createdAt = events.length > 0 ? toMillis(events[0].timestamp) : toMillis(meta?.createdAt);
  let updatedAt = createdAt;
  for (const turn of turns) {
    updatedAt = Math.max(updatedAt, turn.at);
    for (const run of turn.runs) updatedAt = Math.max(updatedAt, run.at);
  }

  let cwd = meta && typeof meta.lastKnownCwd === 'string' && path.isAbsolute(meta.lastKnownCwd) ? meta.lastKnownCwd : null;
  if (!cwd) cwd = resolveCwd(events, path.dirname(filePath));

  const rawTitle = aiTitle || meta?.title || '';  const fallbackTitle = firstUserText(turns) || firstUser || 'WorkBuddy 会话';
  const title = cleanTitle(rawTitle, fallbackTitle);

  let messageCount = 0;
  for (const turn of turns) {
    if (turn.user !== null) messageCount += 1;
    messageCount += turn.runs.length;
  }

  // Normalize a Windows drive-letter lowercase (`c:\...`) back to uppercase so
  // it matches the real filesystem path.
  if (typeof cwd === 'string' && /^[a-z]:[\\/]/.test(cwd)) {
    cwd = cwd.charAt(0).toUpperCase() + cwd.slice(1);
  }

  return {
    source: id,
    id: path.basename(filePath, '.jsonl'),
    title,
    createdAt,
    updatedAt,
    cwd: cwd && /^[A-Za-z]:[\\/]|[\\/]/ .test(cwd) ? cwd : null,
    messageCount,
    turns,
  };
}

/**
 * Attempt to recover the real project directory from the encoded
 * `~/.workbuddy/projects/<encoded-cwd>` folder name.
 */
function importCwdFromProjectDir(projectParent) {
  // projectParent = .../projects/<encoded-cwd>, encoded from the original cwd.
  const encoded = path.basename(projectParent);
  const decoded = decodeCwdEncode(encoded);
  if (decoded && decoded.length > 0 && fs.existsSync(decoded)) return decoded;
  return null;
}

/**
 * WorkBuddy encodes project directories into folder names. The observed form
 * on Windows is `<encoded>` where separators and reserved chars are replaced
 * (e.g. `c-Users-...`, `d-workBuddy_Space-头条`). We do a best-effort string
 * decode: strip a leading drive marker and replace `-` with `\` on Windows.
 * This is lossy for names that contain literal `-`, so the preferred source of
 * truth is `meta.lastKnownCwd` / the `cwd` field on events.
 */
function decodeCwdEncode(encoded) {
  if (typeof encoded !== 'string' || encoded === '') return null;
  const m = encoded.match(/^([cCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ])-?(.*)$/s);
  if (!m) return null;
  const drive = m[1];
  const rest = m[2];
  // The encoded remainder may itself include a drive-colon already; guard.
  const windowsForm = `${drive}:\\${rest.replaceAll('-', '\\')}`;
  if (fs.existsSync(windowsForm)) return windowsForm;
  const posixForm = `/${drive}/${rest.replaceAll('-', '/')}`;
  if (fs.existsSync(posixForm)) return posixForm;
  return windowsForm;
}

/** Map one project directory (encoding the original cwd) to its sessions. */
function listSessionsInProject(projectDir) {
  const sessions = [];
  let entries = [];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return sessions;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    // Session transcripts are named `<uuid>.jsonl`; sub-agent runs use
    // `agent-<hash>.jsonl`. Both are readable transcripts, so keep them and
    // only skip other unrelated jsonl files.
    if (!/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|agent-[0-9a-z]+)\.jsonl$/i.test(entry.name)) continue;
    const full = path.join(projectDir, entry.name);
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    sessions.push({
      file: full,
      id: entry.name.slice(0, -6),
      mtime: toMillis(stat.mtimeMs),
      size: stat.size,
    });
  }
  return sessions;
}

/**
 * Provider contract: report whether WorkBuddy data is readable.
 */
export async function status(env = process.env) {
  const roots = dataRoots(env);
  let available = false;
  let found = [];
  for (const root of roots) {
    if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
      available = true;
      found.push(root);
    }
  }
  return {
    available,
    location: found.join(' ; ') || roots[0],
    error: available ? null : '未找到 ~/.workbuddy/projects',
  };
}

/**
 * Provider contract: list importable conversations (for the selection panel).
 */
export async function list(env = process.env) {
  const root = dataRoot(env);
  const results = [];
  const index = await sessionIndex(env);
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    // Prefer meta.json's lastKnownCwd for the display group + dedup.
    const sessions = listSessionsInProject(projectDir);
    for (const session of sessions) {
      // When WorkBuddy's index is readable it is authoritative: it hides
      // soft-deleted conversations and ignores sub-agent runs entirely.
      const entry = index.available ? index.known.get(session.id) : undefined;
      if (index.available && (entry === undefined || entry.deleted)) continue;
      // WorkBuddy writes almost nothing into `.meta.json` (no title/cwd), so the
      // real project directory and title both have to come from the transcript.
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(projectDir, `${session.id}.meta.json`), 'utf8'));
      } catch {
        meta = null;
      }
      let cwd = entry?.cwd && path.isAbsolute(entry.cwd) ? entry.cwd : null;
      if (!cwd && meta && typeof meta.lastKnownCwd === 'string' && path.isAbsolute(meta.lastKnownCwd)) cwd = meta.lastKnownCwd;
      let title = entry?.title ?? '';
      let firstUser = '';
      const seenEvents = [];
      try {
        const rl = readline.createInterface({
          input: fs.createReadStream(session.file, { encoding: 'utf8' }),
          crlfDelay: Infinity,
        });
        let lineCount = 0;
        for await (const raw of rl) {
          if (lineCount++ > 400) break;
          const ev = parseEvent(raw);
          if (!ev) continue;
          seenEvents.push(ev);
          if (!title && ev.type === 'ai-title' && typeof ev.aiTitle === 'string') title = ev.aiTitle;
          if (!firstUser && ev.type === 'message' && ev.role === 'user') {
            const t = userText(ev);
            if (t.trim() !== '') firstUser = t.trim();
          }
          if (title && firstUser && (cwd || seenEvents.some((e) => typeof e.cwd === 'string'))) break;
        }
        rl.close();
      } catch {
        // ignore
      }
      if (!cwd) cwd = resolveCwd(seenEvents, projectDir);
      const fallbackTitle = titleFromText(firstUser) || 'WorkBuddy 会话';
      results.push({
        id: session.id,
        title: cleanTitle(title, fallbackTitle),
        cwd: cwd && path.isAbsolute(cwd) ? cwd : null,
        cwdLabel: cwd && path.isAbsolute(cwd) ? cwdLabel(cwd) : project.name,
        createdAt: 0,
        updatedAt: toMillis(session.mtime),
        messageCount: null,
        isArchived: false,
      });
    }
  }
  // Sort by updatedAt descending.
  results.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return results;
}

/**
 * Provider contract: read and normalize one conversation.
 */
export async function load(conversationId, env = process.env) {
  const root = dataRoot(env);
  const index = await sessionIndex(env);
  if (index.available) {
    const entry = index.known.get(conversationId);
    if (entry === undefined) throw new Error(`WorkBuddy 会话不存在: ${conversationId}`);
    if (entry.deleted) throw new Error(`WorkBuddy 会话已在 WorkBuddy 中删除: ${conversationId}`);
  }
  const file = findSessionFile(root, conversationId);
  if (!file) throw new Error(`WorkBuddy 会话不存在: ${conversationId}`);
  let meta = null;
  const metaPath = file.replace(/\.jsonl$/, '.meta.json');
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    meta = null;
  }
  return loadFileToConversation(file, meta);
}

/** Locate a session .jsonl by id anywhere under the projects root. */
function findSessionFile(root, conversationId) {
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    // Session ids may be `<uuid>` or `agent-<hash>`; never build a path from raw
    // caller input beyond this safe pattern.
    if (!/^(?:[0-9a-f-]{8,}|agent-[0-9a-z]+)$/i.test(conversationId)) return null;
    const candidate = path.join(root, project.name, `${conversationId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}