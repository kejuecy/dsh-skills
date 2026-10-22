/**
 * Host-side import service: RPC endpoint dispatch and the import job runner.
 *
 * Collaborators:
 *   - `ImportedState`  durable `<source>:<id> → sessionId` map
 *   - `ImportJobs`     in-memory job progress / cancellation / retention
 *   - `SourceScanner`  provider scan cache and list payload
 *   - `writer.js`      session-plan construction and session-log writing
 *
 * Routes (registered by `lib/index.js`):
 *   POST /session-import/list   { refresh?: boolean }        → ListResult
 *   POST /session-import/import { items: [{source,id}],       → { jobId }
 *                                ids?: string[] }             (legacy cursor-only)
 *   POST /session-import/status { jobId }                     → ImportStatus
 *   POST /session-import/cancel { jobId }                     → { cancelled }
 * Every endpoint answers `{ ok: true, value }` or `{ ok: false, error: {...} }`.
 */
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { providerById } from './providers/registry.js';
import { ImportedState, LEGACY_PROVIDER_ID, importKey } from './state.js';
import { ImportJobs } from './jobs.js';
import { SourceScanner } from './scan.js';
import { persistConversation } from './reimport.js';
import { resolveProjectCwd, sourceProjectDirectory } from './platform.js';

export { importKey } from './state.js';

/** Pause between two imported conversations (milliseconds). */
const IMPORT_GAP_MS = 15;

/** Skip the projection-cache warm-up above this event count. */
const WARM_EVENT_LIMIT = 8000;

/** Import modes exposed by the panel. */
const IMPORT_MODES = new Set(['full', 'compatible']);

/** Rough context estimate: characters per model token (mixed CN/EN). */
const CHARS_PER_TOKEN = 3;

/** Full-fidelity transcripts above this estimate get a context warning. */
const LARGE_TRANSCRIPT_CHARS = 1_200_000;

/** Estimate the model-context size of a normalized conversation. */
function estimateTranscriptChars(conversation) {
  let chars = 0;
  for (const turn of conversation.turns ?? []) {
    for (const block of turn.user?.content ?? []) chars += typeof block.text === 'string' ? block.text.length : 0;
    for (const run of turn.runs ?? []) {
      for (const block of run.blocks ?? []) chars += typeof block.text === 'string' ? block.text.length : 0;
      for (const result of run.toolResults ?? []) chars += typeof result.output === 'string' ? result.output.length : 0;
    }
  }
  return chars;
}

/** Resolve the DeepSeek Harness home the same way the CLI does. */
function resolveDshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return configured === '' ? join(homedir(), '.dsh') : configured;
}

/** A RemoteResult-style failure. */
function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

/** A RemoteResult-style success. */
function success(value) {
  return { ok: true, value };
}

/** Sleep helper. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize the import payload into `{ source, id }` items.
 * @param payload - RPC payload.
 * @returns normalized items.
 */
function normalizeItems(payload) {
  const raw = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.ids)
      ? payload.ids.map((id) => ({ source: LEGACY_PROVIDER_ID, id }))
      : [];
  const items = [];
  const seen = new Set();
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const source = typeof entry.source === 'string' && entry.source !== '' ? entry.source : LEGACY_PROVIDER_ID;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (id === '') continue;
    const key = importKey(source, id);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ source, id });
  }
  return items;
}

/** The host-side importer. */
export class ImportService {
  /**
   * @param ctx - host plugin context.
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.home = resolveDshHome();
    this.state = new ImportedState(this.home, ctx.logger);
    this.statePath = this.state.path;
    this.jobs = new ImportJobs();
    this.scanner = new SourceScanner();
  }

  /** Resolve the display labels of every provider, cached for the process. */
  async labels() {
    return this.scanner.labels();
  }

  /**
   * Scan every provider, reusing a fresh cache entry.
   * @param refresh - force a fresh scan.
   * @returns list payload.
   */
  async list(refresh) {
    return this.scanner.list(refresh, this.state.all());
  }

  /** Resolve a writable project directory for one conversation. */
  resolveCwd(conversation) {
    return resolveProjectCwd(conversation.cwd);
  }

  /**
   * Put an imported session under the workspace it came from.
   *
   * DSH groups the sidebar by *registered Workspaces* (`$DSH_HOME/storages/
   * workspace.json`), not by the `cwd` stamped on a session header: a session
   * whose directory is not registered trails in the "未分组" bucket. Importing
   * writes through the persistence seam, which bypasses the workspace registry
   * entirely, so the grouping has to be restored explicitly:
   *
   *   1. reuse the Workspace already registered for that directory, or create
   *      one titled after the directory's own name (that title is exactly what
   *      the sidebar renders as the group label);
   *   2. attach the session to it — `attachSession` re-validates that the
   *      session header's cwd canonicalizes to the workspace path, so a wrong
   *      pairing is refused rather than silently mis-filed.
   *
   * A conversation with no project directory, or one whose directory is the
   * user's home, is left where it is: "未分类" is the honest bucket for it.
   *
   * @param sessionId - the session just written.
   * @param conversation - the normalized conversation (carries the source cwd).
   * @returns `{ title, created, error }`, or null when nothing applied.
   */
  async attachToWorkspace(sessionId, conversation) {
    const directory = sourceProjectDirectory(conversation.cwd);
    if (directory === undefined) return null;
    const title = basename(directory);
    const registry = this.ctx.get('workspaceRegistry') ?? this.ctx.get('workspace');
    if (registry === undefined || typeof registry.create !== 'function') {
      return { title, created: false, error: '当前 DSH 组合没有工作区服务' };
    }
    try {
      const before = new Set(registry.list().map((workspace) => workspace.id));
      const workspace = await registry.create(directory, title);
      await workspace.attachSession(sessionId);
      return {
        title: typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : title,
        created: !before.has(workspace.id),
        error: null,
      };
    } catch (error) {
      return { title, created: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Start importing the requested conversations.
   * @param payload - RPC payload with `items` (or legacy `ids`).
   * @param options - import options.
   * @returns `{ jobId }` or a failure result.
   */
  startImport(payload, options) {
    const active = this.jobs.active();
    if (active !== null && active.state === 'running') {
      return failure('busy', `已有导入任务在进行中（${active.completed ?? 0}/${active.total ?? 0}）`, { jobId: active.jobId });
    }
    const items = normalizeItems(payload);
    if (items.length === 0) return failure('bad-request', '没有选择要导入的对话');
    const mode = IMPORT_MODES.has(options?.mode) ? options.mode : 'full';
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) return failure('unavailable', '当前 DSH 组合没有会话持久化后端，无法写入会话');

    const job = this.jobs.create(items.length, mode);
    this.runJob(job, items, persistence, { ...(options ?? {}), mode }).catch((error) => {
      job.error = error instanceof Error ? error.message : String(error);
      this.jobs.finish(job, 'failed');
      this.ctx.logger.warn(`dsh-agent-session-sync: job ${job.jobId} failed: ${String(error)}`);
    });
    return success({ jobId: job.jobId });
  }

  /**
   * Import conversations sequentially, reporting progress into the job object.
   * @param job - job state.
   * @param items - `{ source, id }` items.
   * @param persistence - session persistence service.
   * @param options - import options.
   */
  async runJob(job, items, persistence, options) {
    for (const item of items) {
      if (this.jobs.cancelRequested) break;
      const key = importKey(item.source, item.id);
      const known = this.state.get(key);
      job.current = { source: item.source, id: item.id, title: known?.title ?? item.id };
      try {
        const provider = await providerById(item.source);
        if (provider === undefined) throw new Error(`未知的导入来源：${item.source}`);
        const conversation = await provider.load(item.id);
        const normalized = {
          ...conversation,
          source: provider.id,
          title: conversation.title || known?.title || `${typeof provider.label === 'string' ? provider.label : provider.id} 对话 ${item.id.slice(0, 8)}`,
        };
        // Surface the real conversation title in the progress modal instead of
        // the raw provider id while the write is running.
        job.current = { source: item.source, id: item.id, title: normalized.title };
        const hasSurface = Array.isArray(normalized.turns) && normalized.turns.some((turn) => turn.user !== null || (Array.isArray(turn.runs) && turn.runs.some((run) => Array.isArray(run.blocks) && run.blocks.length > 0)));
        if (!hasSurface) {
          job.results.push({ source: item.source, id: item.id, title: normalized.title, ok: false, skipped: true, error: '这条对话没有可导入的消息' });
        } else {
          const cwd = this.resolveCwd(normalized);
          const transcriptChars = estimateTranscriptChars(normalized);
          const warnings = [];
          if (options.mode !== 'compatible' && transcriptChars > LARGE_TRANSCRIPT_CHARS) {
            warnings.push(`历史较长（约 ${Math.round(transcriptChars / CHARS_PER_TOKEN / 1000)}k tokens），续聊会占用较多上下文；如需继续对话建议以「接续友好」模式重新导入`);
          }
          // A re-import merges into the session the previous import created:
          // only the turns the source gained are appended, so anything written
          // in DSH in the meantime (a local follow-up, a compaction summary)
          // survives. Deleting and rewriting — the old behaviour — silently
          // destroyed exactly that. `persistConversation` owns the whole policy,
          // including why a fallback had to be taken.
          const outcome = await persistConversation(persistence, normalized, {
            cwd,
            mode: options.mode,
            sourceLabel: provider.label,
            knownSessionId: known?.sessionId,
            isOpen: known?.sessionId !== undefined && this.isSessionOpen(known.sessionId),
            allowMerge: options.merge !== false,
          });
          const { written, merged, addedTurns } = outcome;
          warnings.push(...outcome.warnings);
          // An untouched merge has no plan: nothing was written to warm.
          const warmed = written.plan === undefined ? false : await this.warmProjectionCache(written.sessionId, written.plan);
          // Group the new session under the workspace it came from. This is the
          // difference between "another 未分组 entry" and the sidebar showing
          // 「DeepHarness」 above it; a project-less conversation is skipped and
          // stays ungrouped on purpose.
          const workspace = options.groupByWorkspace === false
            ? null
            : await this.attachToWorkspace(written.sessionId, normalized);
          if (workspace !== null && workspace.error !== null) {
            warnings.push(`未能归入工作区「${workspace.title}」：${workspace.error}（会话已导入，位置在「未分组」）`);
          }
          this.state.set(key, {
            source: item.source,
            remoteId: item.id,
            sessionId: written.sessionId,
            importedAt: Date.now(),
            title: normalized.title,
            cwd,
            messageCount: normalized.messageCount ?? null,
            mode: options.mode,
            transcriptChars,
            projectionCacheWarmed: warmed,
            // A merge keeps the session the previous import created and appends
            // only what the source gained, so record that it happened: the
            // panel says so, and the next re-import can tell a merge from a
            // fresh write when reading the row back.
            merged,
            addedTurns,
          });
          job.results.push({
            source: item.source,
            id: item.id,
            title: normalized.title,
            ok: true,
            sessionId: written.sessionId,
            cwd,
            importedMessages: normalized.messageCount ?? null,
            mode: options.mode,
            // `replaced` is true only when the old session was actually removed
            // and rewritten in place. A re-import that could not delete falls
            // back to a new session, and the panel tells the user so.
            replaced: written.replaced === true,
            // `merged` is the normal re-import path now: the existing session
            // was extended in place. `addedTurns` is how many turns that
            // appended — 0 means the source had nothing new.
            merged,
            addedTurns,
            // Where the sidebar will show it: `null` means "未分组" (the source
            // conversation named no project directory).
            workspace: workspace === null ? null : { title: workspace.title, created: workspace.created },
            ...(warnings.length === 0 ? {} : { warnings }),
          });
        }
      } catch (error) {
        job.results.push({
          source: item.source,
          id: item.id,
          title: known?.title ?? item.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      job.completed += 1;
      job.current = null;
      if (IMPORT_GAP_MS > 0) await sleep(IMPORT_GAP_MS);
    }
    const finalState = this.jobs.cancelRequested ? 'cancelled' : 'done';
    this.jobs.finish(job, finalState);
    const okCount = job.results.filter((result) => result.ok === true).length;
    this.ctx.logger.info(`dsh-agent-session-sync: job ${job.jobId} ${finalState} (${okCount}/${job.total} imported)`);
  }

  /**
   * Whether a session is currently loaded in the running harness.
   *
   * A live session keeps its own copy of the transcript in memory and flushes it
   * back on the next write, so overwriting it on disk would be silently undone
   * (and could corrupt the open conversation). The check is deliberately
   * conservative: when the registry is unavailable we assume it is not open and
   * let the persistence layer decide.
   *
   * @param sessionId - session id to test.
   * @returns true when the harness has it loaded.
   */
  isSessionOpen(sessionId) {
    try {
      const sessions = this.ctx.get('sessions');
      if (sessions === undefined || typeof sessions.get !== 'function') return false;
      return sessions.get(sessionId) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Warm the projection cache for a freshly written session so the sidebar shows
   * its real title immediately. The session is only cached, never opened: if the
   * harness already has it loaded this returns false without touching it.
   *
   * @param sessionId - persisted session id.
   * @param plan - `{ header, events }` produced by the writer.
   * @returns whether a checkpoint was written.
   */
  async warmProjectionCache(sessionId, plan) {
    const sessions = this.ctx.get('sessions');
    const cache = this.ctx.get('sessionProjectionCache');
    if (sessions === undefined || cache === undefined) return false;
    if (sessions.get(sessionId) !== undefined) return false;
    // Folding a huge log just to prefill the list title is not worth blocking
    // the job; the title appears when the session is first opened instead.
    if (plan.events.length > WARM_EVENT_LIMIT) return false;
    try {
      const session = sessions.prepare(sessionId, {
        seed: plan.events,
        meta: {
          createdAt: plan.header.createdAt,
          cwd: plan.header.cwd,
          isSeeded: false,
          delegationDepth: 0,
        },
      });
      await cache.write(session);
      return true;
    } catch (error) {
      this.ctx.logger.warn(`dsh-agent-session-sync: projection warm-up for ${sessionId} failed: ${String(error)}`);
      return false;
    }
  }

  /** Return a status snapshot for one job. */
  status(jobId) {
    const snapshot = this.jobs.status(jobId);
    if (snapshot === null) return failure('not-found', '找不到这个导入任务（可能已过期，重新扫描即可）');
    return snapshot;
  }

  /** Request cancellation of the running job. */
  cancel(jobId) {
    const result = this.jobs.cancel(jobId);
    if (result === null) return failure('not-found', '找不到这个导入任务');
    return result;
  }

  /**
   * Dispatch one HTTP endpoint call.
   * @param endpoint - endpoint name.
   * @param payload - JSON payload.
   * @returns RemoteResult.
   */
  async handle(endpoint, payload) {
    try {
      const body = payload !== null && typeof payload === 'object' ? payload : {};
      switch (endpoint) {
        case 'list':
          return success(await this.list(body.refresh === true));
        case 'import':
          return this.startImport(body, body.options);
        case 'status': {
          const result = this.status(body.jobId);
          return result?.ok === false ? result : success(result);
        }
        case 'cancel': {
          const result = this.cancel(body.jobId);
          return result?.ok === false ? result : success(result);
        }
        default:
          return failure('unknown-endpoint', `unknown endpoint: ${String(endpoint)}`);
      }
    } catch (error) {
      return failure('internal', error instanceof Error ? error.message : String(error));
    }
  }

  /** Release cached state (the service has no timers of its own). */
  dispose() {
    this.jobs.clear();
    this.scanner.clear();
  }
}
