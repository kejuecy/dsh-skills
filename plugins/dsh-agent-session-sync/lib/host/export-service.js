/**
 * Host-side export service: the mirror of `service.js`.
 *
 * Collaborators:
 *   - `dsh-source.js`     reads DSH sessions into the neutral conversation model
 *   - `sinks/registry.js` resolves export targets
 *   - `sinks/*.js`        write one conversation into a third-party agent
 *
 * Routes (registered by `lib/index.js`):
 *   POST /session-export/sources  { ids? }          → { conversations, pageOnly, total }
 *   POST /session-export/targets                    → { targets }
 *   POST /session-export/export  { id, target, options } → ExportPlan | ExportResult
 *   POST /session-export/status  { jobId }          → ExportStatus
 *
 * Every endpoint answers `{ ok: true, value }` or `{ ok: false, error }`.
 *
 * Two-step by design: calling `export` without `options.confirm === true`
 * returns a *plan* (paths, row counts, overwrite warnings) and touches nothing.
 * The panel shows that plan and sends `confirm: true` after the user agrees.
 */
import { listDshConversations, loadDshConversation, scanDshSessions } from './dsh-source.js';
import { sinkById, sinkLabels, sinks } from './sinks/registry.js';
import { ImportJobs } from './jobs.js';

/** A RemoteResult-style failure. */
function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

/** A RemoteResult-style success. */
function success(value) {
  return { ok: true, value };
}

/** Listenable export targets. */
const MODES = new Set(['full', 'flat']);

/** Normalize an optional string field: trimmed text, or `undefined` when empty. */
function text(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The spellings one session id may appear under.
 *
 * A folder name on disk is the session id verbatim — native DSH sessions use a
 * bare UUID there, sessions this plugin wrote use `session-<uuid>`, and the
 * session list may report either shape. Matching both spellings keeps the
 * filter from dropping a session just because the page labelled it differently.
 * @param id - trimmed session id.
 * @returns one or two candidate ids.
 */
function idVariants(id) {
  return id.startsWith('session-') ? [id, id.slice('session-'.length)] : [id, `session-${id}`];
}

/** The host-side exporter. */
export class ExportService {
  /**
   * @param ctx - host plugin context.
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.jobs = new ImportJobs();
  }

  /**
   * List the DSH conversations available for export.
   *
   * The panel sends `ids` — exactly the sessions the DSH page is listing — so
   * the selection cannot reach a session the user cannot see (another
   * workspace's history, an archived or sub-agent session). Without `ids` the
   * whole machine is listed, which is what a hand-written API caller wants and
   * what an older DSH release without a session-list feed falls back to.
   *
   * @param payload - `{ ids?: string[] }`.
   * @returns `{ conversations, pageOnly, total, hidden }`.
   */
  async sources(payload) {
    const body = payload !== null && typeof payload === 'object' ? payload : {};
    const requested = Array.isArray(body.ids)
      ? body.ids.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
      : null;

    // `scanDshSessions` only stats transcript files, so counting everything is
    // cheap even when the answer is filtered down to a handful.
    const everything = scanDshSessions();
    const total = everything.length;

    let listed;
    if (requested === null) {
      listed = listDshConversations();
    } else {
      const allowed = new Set();
      for (const id of requested) {
        for (const variant of idVariants(id)) allowed.add(variant);
      }
      const files = new Set();
      for (const entry of everything) {
        if (allowed.has(entry.id)) files.add(entry.file);
      }
      listed = listDshConversations({ files });
    }

    // A delegated run never gets a row of its own on the page — it is reached
    // through its parent — so it is not offered here either. This holds even
    // when the browser could not report its page list and `ids` is absent.
    const conversations = listed.filter((row) => row.origin !== 'subagent');

    return {
      conversations,
      pageOnly: requested !== null,
      total,
      hidden: Math.max(0, total - conversations.length),
    };
  }

  /** Describe every export target with its availability. */
  async targets() {
    const list = await sinks();
    const out = [];
    for (const module of list) {
      let state = { available: false, location: null, error: '未提供状态查询' };
      if (typeof module.status === 'function') {
        try {
          state = await module.status(process.env);
        } catch (error) {
          state = { available: false, location: null, error: error instanceof Error ? error.message : String(error) };
        }
      }
      out.push({
        id: module.id,
        label: typeof module.label === 'string' ? module.label : module.id,
        description: typeof module.description === 'string' ? module.description : '',
        overwrite: module.overwrite === true,
        available: state.available === true,
        location: state.location ?? null,
        error: state.error ?? null,
      });
    }
    return out;
  }

  /** Resolve labels once (used when the panel has no target list yet). */
  async labels() {
    return sinkLabels();
  }

  /**
   * Export one DSH conversation to one target.
   *
   * Accepts two payload shapes so the panel and hand-written callers can both
   * feel natural:
   *   `{ id, target, options: { mode, confirm, overwrite, … } }`  (documented)
   *   `{ sourceId, targetId, mode, confirm, overwrite, … }`       (flat)
   * A flat field only applies when the nested `options` did not set it.
   *
   * @param payload - either shape above.
   * @returns plan (dry run) or write result.
   */
  async exportOne(payload) {
    const body = payload !== null && typeof payload === 'object' ? payload : {};
    const nested = body.options !== null && typeof body.options === 'object' ? body.options : {};
    // Flat keys fill the gaps, so a caller may mix shapes without surprises.
    const raw = { ...body, ...nested };

    const sourceId = text(body.id ?? body.sourceId);
    const targetId = text(body.target ?? body.targetId);
    if (sourceId === '') return failure('bad-request', '缺少要导出的会话 id');
    if (targetId === '') return failure('bad-request', '缺少导出目标');

    const confirm = raw.confirm === true;
    const options = {
      dryRun: confirm !== true,
      force: raw.force === true,
      // `overwrite` defaults to true here because the Host only writes after an
      // explicit confirm; the panel still sends its own toggle explicitly.
      overwrite: raw.overwrite !== false,
      flattenTools: raw.mode === 'flat',
      sessionId: text(raw.sessionId),
      cwd: text(raw.cwd),
      title: text(raw.title),
      targetProject: text(raw.targetProject),
    };
    if (!MODES.has(raw.mode)) delete options.flattenTools;

    const sink = await sinkById(targetId);
    if (sink === undefined) return failure('unknown-target', `未知的导出目标：${targetId}`);

    let conversation;
    try {
      conversation = loadDshConversation(sourceId);
    } catch (error) {
      return failure('source-unreadable', error instanceof Error ? error.message : String(error));
    }

    try {
      const result = await sink.write(conversation, options);
      this.ctx.logger.info(
        `dsh-session-export: ${result.dryRun === true ? 'planned' : 'wrote'} ${sourceId} → ${targetId}` +
          `${result.dryRun === true ? '' : ` (${result.target})`}`,
      );
      return success({ ...result, source: { id: conversation.id, title: conversation.title } });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'write-failed';
      return failure(code, error instanceof Error ? error.message : String(error));
    }
  }

  /** Dispatch one HTTP endpoint call. */
  async handle(endpoint, payload) {
    try {
      const body = payload !== null && typeof payload === 'object' ? payload : {};
      switch (endpoint) {
        case 'sources':
          return success(await this.sources(body));
        case 'targets':
          return success({ targets: await this.targets() });
        case 'export':
          return this.exportOne(body);
        default:
          return failure('unknown-endpoint', `unknown endpoint: ${String(endpoint)}`);
      }
    } catch (error) {
      return failure('internal', error instanceof Error ? error.message : String(error));
    }
  }

  /** Release cached state. */
  dispose() {
    this.jobs.clear();
  }
}
