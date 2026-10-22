/**
 * Turn one normalized conversation into a durable DSH session.
 *
 * The session is written through the public persistence seam
 * (`ctx.sessionPersistence.create/append/flush/close`), so the backend owns
 * directory escaping, Zstandard framing, locking and crash recovery.
 *
 * Two event shapes are supported:
 *
 *  - `mode: 'full'` (default) — faithful transcript: assistant text/reasoning/
 *    tool-call content blocks plus `tool/call` + `tool/result` events. Best for
 *    reading; resuming may hit model-provider rules about historical thinking
 *    blocks and tool-call ids.
 *  - `mode: 'compatible'` — resume-safe transcript: every model round becomes a
 *    plain assistant text message (tool calls/results inlined as text, reasoning
 *    omitted) and no tool wire events are written. Any provider accepts this
 *    history, and it is much cheaper in context.
 *
 * Both modes start the surface with an empty, protected `system/message` head:
 * DSH v4 requires one so the agent loop can append its system prompt on resume,
 * and the projection of empty content contributes no wire message.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Maximum characters kept in a transcript title. */
const TITLE_MAX_CHARS = 160;

/** Opening marker of the provenance note; a re-import strips it before comparing. */
const NOTICE_HEAD = '【导入说明】';

/**
 * Closing sentence of the provenance note. It is a constant rather than a
 * literal inside the builder because `stripImportNotice` anchors on it: the
 * note is re-read from disk by a later import, which has to find its end.
 */
const NOTICE_TAIL = '继续对话时请使用本会话当前实际提供的工具。';

/** Maximum characters of one tool-call argument summary in compatible mode. */
const COMPATIBLE_ARGS_MAX = 4_000;

/** Provider/model pair recorded on imported assistant messages (neutral, so
 * the LLM adapter never mistakes imported history for another model's replay). */
function modelSource(conversation) {
  const provider = typeof conversation.source === 'string' && conversation.source !== '' ? conversation.source : 'imported';
  return { kind: 'model', provider, model: 'imported' };
}

/** Clamp a millisecond timestamp to a non-negative safe integer. */
function safeTime(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0) return Math.trunc(fallback);
  return Date.now();
}

/** One-line transcript title. */
function cleanTitle(title, fallback) {
  const text = typeof title === 'string' ? title.replaceAll(/\s+/g, ' ').trim() : '';
  if (text === '') return fallback;
  return text.length <= TITLE_MAX_CHARS ? text : `${text.slice(0, TITLE_MAX_CHARS)}…`;
}

/**
 * Make a tool-call id acceptable to every model provider: the Anthropic-style
 * wire format (and DeepSeek's compatible endpoint) accept only
 * `[A-Za-z0-9_-]`. Imported ids frequently contain newlines, spaces, `/` or
 * `:` (measured 64% on one large Cursor conversation), which would make a
 * resumed request invalid.
 * @param raw - source call id.
 * @param used - per-conversation map of already produced ids.
 * @returns sanitized, conversation-unique id.
 */
function sanitizeCallId(raw, used) {
  let base = typeof raw === 'string' ? raw : '';
  base = base.replaceAll(/[^A-Za-z0-9_-]/g, '_').replaceAll(/_+/g, '_');
  if (base === '') base = 'call';
  if (base.length > 96) base = base.slice(0, 96);
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}_${count + 1}`;
}

/**
 * Normalize historical tool arguments to a JSON object string.
 *
 * Some agents store arguments as a JSON-encoded string inside the arguments
 * string (double encoding, measured on 19–52% of historical tool calls). The
 * DSH provider adapter does `JSON.parse(raw)` once and silently degrades a
 * non-object result to `{}`, so unwrap until an object/array appears; wrap
 * scalars so the call still shows its input.
 * @param raw - argument string.
 * @returns JSON object string.
 */
function normalizeArguments(raw) {
  const text = typeof raw === 'string' ? raw : '';
  if (text.trim() === '') return '{}';
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return JSON.stringify({ text });
  }
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  if (typeof value === 'string') return JSON.stringify({ text: value });
  if (value === null || typeof value !== 'object') return JSON.stringify({ value });
  if (Array.isArray(value)) return JSON.stringify({ items: value });
  return JSON.stringify(value);
}

/** Inline one tool call as compatible-mode text. */
function toolCallLine(block, argumentsJson) {
  const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool';
  const args = argumentsJson.length <= COMPATIBLE_ARGS_MAX ? argumentsJson : `${argumentsJson.slice(0, COMPATIBLE_ARGS_MAX)}…`;
  return `[工具调用] ${name} ${args}`;
}

/**
 * The user-visible provenance note prepended to the first user message.
 *
 * It is deliberately a normal user-role text block, not a system message:
 * DSH composes its own system prompt per route (cwd, tools, preset, model) and
 * rewrites the protected system head on resume, so an imported prompt there
 * would be replaced or duplicated. User-role context notes are how the harness
 * itself injects context, and they survive every resume path.
 * @param conversation - normalized conversation.
 * @param options - writer options (carries the provider display label).
 * @returns the note text.
 */
function importNotice(conversation, options) {
  const rawLabel = options?.sourceLabel ?? conversation.source;
  const label = typeof rawLabel === 'string' && rawLabel !== '' ? rawLabel : '第三方 agent';
  return [
    NOTICE_HEAD,
    `本会话由 ${label} 导入到 DeepSeek Harness。`,
    '历史中的工具调用与结果属于原 agent（工具名可能与当前 DSH 不同，例如 read_file_v2、run_terminal_command_v2、exec、mcp_*），仅作为历史记录；',
    NOTICE_TAIL,
  ].join('');
}

/**
 * Remove the provenance note from an imported prompt, if present.
 *
 * A re-import compares the DSH session's turns against the source's turns to
 * find where the two logs stop agreeing. The first stored prompt carries the
 * notice described above while the source does not, so leaving it in would make
 * turn 0 differ on every comparison and no re-import could ever overlap.
 *
 * @param text - user message text read back from a DSH session.
 * @returns the text without the note.
 */
export function stripImportNotice(text) {
  const value = typeof text === 'string' ? text : '';
  const head = value.indexOf(NOTICE_HEAD);
  if (head !== 0) return value;
  const tail = value.indexOf(NOTICE_TAIL);
  if (tail === -1) return value;
  return value.slice(tail + NOTICE_TAIL.length);
}

/**
 * Normalize a caller-supplied session id.
 *
 * DSH ids are always `session-<uuid>`. A stored id from an earlier import is
 * reused verbatim so a re-import lands on the same session; anything else is
 * rejected rather than silently creating a second copy.
 *
 * @param value - candidate id.
 * @returns the id to use, or undefined when absent/invalid.
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return /^session-[0-9a-f-]{8,}$/i.test(trimmed) ? trimmed : undefined;
}

/** Inline one tool result as compatible-mode text. */
function toolResultLine(result) {
  const output = typeof result.output === 'string' ? result.output : '';
  const prefix = result.isError === true ? '[工具结果: 错误]' : '[工具结果]';
  return `${prefix} ${output === '' ? '[没有输出]' : output}`;
}

/**
 * Build the session header and event log for one conversation.
 *
 * @param conversation - normalized conversation from a provider.
 * @param options - writer options:
 *   - `cwd` — session working directory.
 *   - `mode` — `'full'` or `'compatible'`.
 *   - `sessionId` — reuse an existing DSH id instead of minting one.
 *   - `importNotice` — `false` to omit the provenance note.
 *   - `continues` — append to an existing log instead of starting one: skips
 *     the protected system head, the title event and the provenance note, all
 *     of which the stored log already has.
 *   - `seqBase` / `turnBase` — first seq / turn number to use; DSH requires a
 *     log contiguous from seq 0 and monotonically increasing turn numbers.
 *   - `minTime` — clamp every event time to at least this, so an appended
 *     turn can never look older than the log it joins.
 * @returns `{ header, events, mode }`.
 */
export function buildSessionPlan(conversation, options) {
  const mode = options?.mode === 'compatible' ? 'compatible' : 'full';
  const continues = options?.continues === true;
  const createdAt = safeTime(conversation.createdAt, Date.now());
  const header = {
    // The persistence seam stores the current logical header shape, which
    // includes the format version (4 today); the backend stamps it physically.
    version: 4,
    // Reusing an id rewrites that session in place, which is how a re-import
    // replaces the previous copy instead of leaving a duplicate behind.
    id: normalizeSessionId(options?.sessionId) ?? `session-${randomUUID()}`,
    createdAt,
    cwd: options.cwd,
    isSeeded: false,
    delegationDepth: 0,
  };

  const seqBase = Number.isSafeInteger(options?.seqBase) && options.seqBase >= 0 ? options.seqBase : 0;
  const minTime = Number.isSafeInteger(options?.minTime) && options.minTime > 0 ? options.minTime : 0;

  const events = [];
  let seq = seqBase;
  /** Append one event and return it. */
  const push = (type, data, time, surfaceOp) => {
    const event = { type, seq: seq++, time: Math.max(safeTime(time, createdAt), minTime), data };
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
    events.push(event);
    return event;
  };
  const title = cleanTitle(conversation.title, `导入的对话 ${String(conversation.id).slice(0, 8)}`);
  const notice = continues || options?.importNotice === false ? null : importNotice(conversation, options);
  let noticeWritten = notice === null;
  const usedCallIds = new Map();
  let titleWritten = continues;
  let systemHeadWritten = continues;
  let turnNumber = Number.isSafeInteger(options?.turnBase) && options.turnBase >= 0 ? options.turnBase : 0;

  for (const turn of conversation.turns) {
    turnNumber += 1;
    const turnTime = safeTime(turn.at, createdAt);
    push('turn/start', { turn: turnNumber }, turnTime);

    let stepNumber = 1;
    let stepStarted = false;
    let lastTime = turnTime;
    const startStep = (time) => {
      push('step/start', { turn: turnNumber, step: stepNumber }, time);
      // DSH v4 requires a protected `system/message` surface head: the
      // agent-loop appends a system prompt on resume, and cold readers reject
      // any later system node whose head is not protected. An empty head
      // projects to no wire message but claims surface node 0.
      if (!systemHeadWritten) {
        push(
          'system/message',
          {
            turn: turnNumber,
            step: stepNumber,
            message: { id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [] },
          },
          time,
          'append',
        );
        systemHeadWritten = true;
      }
      stepStarted = true;
      lastTime = time;
    };
    const endStep = (time) => {
      if (!stepStarted) return;
      push('step/end', { turn: turnNumber, step: stepNumber }, time);
      stepStarted = false;
      lastTime = time;
    };
    const nextStep = (time) => {
      endStep(time);
      stepNumber += 1;
      startStep(time);
    };

    // The user prompt opens the turn's first step.
    if (turn.user !== null) {
      startStep(turnTime);
      const content = [];
      if (!noticeWritten) {
        content.push({ type: 'text', text: notice });
        noticeWritten = true;
      }
      for (const block of turn.user.content) content.push(block);
      const message = {
        role: 'user',
        source: { kind: 'user' },
        content,
        id: randomUUID(),
      };
      push('user/message', message, turnTime, 'append');
      if (!titleWritten) {
        // A user-sourced title must carry no source message seqs; the title is
        // the conversation's own name, not a model-generated one.
        push('session/title', { title, messageSeqs: [], source: { kind: 'user' } }, turnTime);
        titleWritten = true;
      }
    }

    let firstRun = true;
    for (const run of turn.runs) {
      const runTime = safeTime(run.at, lastTime);
      if (!stepStarted) {
        startStep(runTime);
      } else if (!firstRun) {
        nextStep(runTime);
      }
      firstRun = false;

      if (mode === 'compatible') {
        // One plain assistant message per model round. This mode makes resumed
        // requests safe (no foreign tool_use ids, no unsigned thinking wire
        // blocks) — it does NOT drop content: text, reasoning, tool calls and
        // results are all kept, just flattened to text.
        const lines = [];
        for (const block of run.blocks) {
          if (block.type === 'text') lines.push(block.text);
          else if (block.type === 'reasoning') lines.push(`【思考】${block.text}`);
          else if (block.type === 'tool-call') lines.push(toolCallLine(block, normalizeArguments(block.arguments)));
        }
        for (const result of run.toolResults) lines.push(toolResultLine(result));
        const text = lines.filter((line) => typeof line === 'string' && line.trim() !== '').join('\n\n');
        if (text !== '') {
          push(
            'assistant/message',
            {
              turn: turnNumber,
              step: stepNumber,
              message: {
                id: randomUUID(),
                role: 'assistant',
                source: modelSource(conversation),
                content: [{ type: 'text', text }],
              },
              stream: [],
            },
            runTime,
            'append',
          );
        }
        lastTime = runTime;
        continue;
      }

      // ── faithful mode ────────────────────────────────────────────────────
      const content = [];
      const callIds = [];
      for (const block of run.blocks) {
        if (block.type === 'tool-call') {
          const id = sanitizeCallId(block.id, usedCallIds);
          callIds.push(id);
          content.push({ type: 'tool-call', id, name: block.name, arguments: normalizeArguments(block.arguments) });
        } else if (block.type === 'reasoning') {
          content.push({ type: 'reasoning', text: block.text });
        } else if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
        }
      }
      if (content.length > 0) {
        push(
          'assistant/message',
          {
            turn: turnNumber,
            step: stepNumber,
            message: {
              id: randomUUID(),
              role: 'assistant',
              source: modelSource(conversation),
              content,
            },
            stream: [],
          },
          runTime,
          'append',
        );
      }
      let resultIndex = 0;
      for (const result of run.toolResults) {
        const resultTime = safeTime(result.at, runTime);
        const id = resultIndex < callIds.length ? callIds[resultIndex] : sanitizeCallId(result.callId, usedCallIds);
        resultIndex += 1;
        const text = typeof result.output === 'string' && result.output !== '' ? result.output : '[没有输出]';
        // v4 tracks an advertised → started → settled tool lifecycle: the
        // assistant message advertises the call, `tool/call` starts it, and
        // `tool/result` settles it. The event is trace-only (no surfaceOp).
        push(
          'tool/call',
          {
            turn: turnNumber,
            step: stepNumber,
            callId: id,
            name: result.name,
            arguments: normalizeArguments(result.arguments),
          },
          resultTime,
        );
        push(
          'tool/result',
          {
            turn: turnNumber,
            step: stepNumber,
            message: {
              id: randomUUID(),
              role: 'tool',
              source: { kind: 'tool', callId: id },
              toolCallId: id,
              content: [{ type: 'text', text }],
              ...(result.isError === true ? { isError: true } : {}),
            },
          },
          resultTime,
          'append',
        );
        lastTime = resultTime;
      }
      lastTime = Math.max(lastTime, runTime);
    }
    endStep(lastTime);
    push('turn/end', { turn: turnNumber, reason: { kind: 'completed' } }, lastTime);
  }

  // A transcript with no title event still needs one for the history list.
  if (!titleWritten) push('session/title', { title, messageSeqs: [], source: { kind: 'user' } }, createdAt);
  return { header, events, mode };
}

/**
 * Remove an existing session so it can be written again under the same id.
 *
 * Removal is attempted hierarchy-first: the backend's own deletion entry point
 * when it has one, then `locate()` + directory removal. The directory path is
 * validated before use — it must sit under a `sessions` directory, must exist,
 * and must not be a symlink — because deleting the wrong directory would be
 * unrecoverable. When neither route works the caller falls back to creating a
 * fresh session rather than risking a half-deleted transcript.
 *
 * @param persistence - `ctx.sessionPersistence` service.
 * @param sessionId - id to remove.
 * @returns `{ removed, how }`; `how` names the route that succeeded.
 */
async function removeExistingSession(persistence, sessionId) {
  for (const method of ['remove', 'delete', 'destroy', 'drop']) {
    if (typeof persistence?.[method] !== 'function') continue;
    try {
      await persistence[method](sessionId);
      return { removed: true, how: method };
    } catch {
      // The backend has the method but refused this id; try the next one.
    }
  }

  if (typeof persistence?.locate === 'function') {
    let target;
    try {
      const location = await persistence.locate({ version: 4, id: sessionId });
      target = typeof location?.path === 'string' ? location.path : undefined;
    } catch {
      target = undefined;
    }
    if (target !== undefined && isRemovableTranscript(target)) {
      try {
        await fs.promises.rm(target, { recursive: true, force: true });
        return { removed: true, how: 'locate' };
      } catch {
        // Locked or already gone: treat as unsupported and let the caller degrade.
      }
    }
  }
  return { removed: false, how: null };
}

/**
 * Whether a path is safe to delete as a session transcript.
 *
 * Guards the three ways this could delete too much: a path outside the session
 * store, a symlink that redirects elsewhere, and a plain file that is not the
 * transcript artifact itself.
 *
 * @param target - candidate path from `persistence.locate()`.
 * @returns true when deleting it can only affect that one session.
 */
function isRemovableTranscript(target) {
  try {
    const resolved = path.resolve(target);
    const segments = resolved.split(/[\\/]+/);
    if (!segments.includes('sessions')) return false;
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) return false;
    // Either the session directory or the transcript file inside it.
    return stat.isDirectory() || path.basename(resolved).startsWith('session.');
  } catch {
    return false;
  }
}

/**
 * Write one conversation through the persistence seam.
 *
 * With `options.sessionId` the write targets that session. `options.overwrite`
 * additionally asks the backend to drop the previous copy first, so a re-import
 * replaces the old DSH session instead of leaving a duplicate beside it. If the
 * backend cannot delete, the write still happens — under the reused id when the
 * backend tolerates it, otherwise as a new session — and `replaced` reports
 * what actually occurred so the caller can tell the user.
 *
 * @param persistence - `ctx.sessionPersistence` service.
 * @param conversation - normalized conversation.
 * @param options - `{ cwd, mode?, sessionId?, overwrite? }`.
 * @returns `{ sessionId, eventCount, plan, replaced, removedVia }`.
 */
export async function writeSession(persistence, conversation, options) {
  const reuseId = normalizeSessionId(options?.sessionId);
  let replaced = false;
  let removedVia = null;

  if (reuseId !== undefined && options?.overwrite === true) {
    const removal = await removeExistingSession(persistence, reuseId);
    replaced = removal.removed;
    removedVia = removal.how;
  }

  let plan = buildSessionPlan(conversation, options);
  let handle;
  try {
    handle = await persistence.create(plan.header);
  } catch (error) {
    // The backend refused the reused id (usually "already exists"). A brand new
    // session is better than losing the import, so retry once without the id.
    if (reuseId === undefined) throw error;
    plan = buildSessionPlan(conversation, { ...options, sessionId: undefined });
    handle = await persistence.create(plan.header);
    replaced = false;
    removedVia = null;
  }

  try {
    await handle.append(plan.events);
    await handle.flush();
  } finally {
    await handle.close();
  }
  return { sessionId: plan.header.id, eventCount: plan.events.length, plan, replaced, removedVia };
}
