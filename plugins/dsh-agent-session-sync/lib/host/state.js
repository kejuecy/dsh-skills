/**
 * Durable `<source>:<id> → imported session` map for the importer.
 *
 * The map lives in `$DSH_HOME/session-import/imported.json` and is written
 * atomically after every successful import. State produced before multiple
 * sources existed (bare Cursor ids) is migrated in place on load.
 *
 * The exporter reads the same file in the opposite direction (`findBySession`)
 * so a session can be written *back* to the conversation it came from instead
 * of piling a second copy beside it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Resolve the DeepSeek Harness home the same way the CLI does. */
export function resolveDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return configured === '' ? join(homedir(), '.dsh') : configured;
}

/**
 * One session id with its optional `session-` prefix removed.
 * @param id - stored or reported session id.
 * @returns comparable key (empty string when there is nothing to compare).
 */
function normalizeSessionKey(id) {
  const raw = typeof id === 'string' ? id.trim() : '';
  if (raw === '') return '';
  return /^session-/i.test(raw) ? raw.slice('session-'.length) : raw;
}

/** Provider id assumed by the legacy bare-id state format. */
export const LEGACY_PROVIDER_ID = 'cursor';

/**
 * Stable map/selection key for one conversation.
 * @param source - provider id.
 * @param id - provider-local conversation id.
 * @returns `"<source>:<id>"`.
 */
export function importKey(source, id) {
  return `${source}:${id}`;
}

/** Persisted imported-conversation map. */
export class ImportedState {
  /**
   * @param home - DeepSeek Harness home directory.
   * @param logger - optional logger for non-fatal save failures.
   */
  constructor(home, logger = console) {
    this.logger = logger;
    this.path = join(home, 'session-import', 'imported.json');
    this.legacyPath = join(home, 'cursor-import', 'imported.json');
    this.entries = this.load();
  }

  /** Read the durable map, migrating pre-provider (bare-id) keys. */
  load() {
    try {
      const sourcePath = existsSync(this.path) ? this.path : this.legacyPath;
      if (!existsSync(sourcePath)) return {};
      const parsed = JSON.parse(readFileSync(sourcePath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const migrated = {};
      for (const [key, value] of Object.entries(parsed)) {
        migrated[key.includes(':') ? key : importKey(LEGACY_PROVIDER_ID, key)] = value;
      }
      return migrated;
    } catch {
      return {};
    }
  }

  /** Snapshot of every imported entry, keyed by `importKey()`. */
  all() {
    return this.entries;
  }

  /**
   * One imported entry.
   * @param key - `importKey()` value.
   * @returns entry or undefined.
   */
  get(key) {
    return this.entries[key];
  }

  /**
   * The third-party conversation one DSH session was imported from.
   *
   * Import mints a fresh DSH id, so this map is the only place that still
   * remembers which conversation a session came from — the reverse direction
   * of `get()`. The exporter needs it: writing a session back under a *new*
   * target id is what left two identical-looking sessions in the target app,
   * because the original one was never touched.
   *
   * @param sessionId - DSH session id (`session-<uuid>`).
   * @returns `{ source, remoteId, key, …entry }`, or undefined when the session
   *   was created natively (nothing to go back to).
   */
  findBySession(sessionId) {
    const target = normalizeSessionKey(sessionId);
    if (target === '') return undefined;
    for (const [key, entry] of Object.entries(this.entries)) {
      if (entry === null || typeof entry !== 'object') continue;
      // Stored ids and the ids the session list reports disagree on the
      // `session-` prefix (native folders use the bare uuid), so compare the
      // normalized form rather than the raw string.
      if (normalizeSessionKey(entry.sessionId) !== target) continue;
      const marker = key.indexOf(':');
      const source = typeof entry.source === 'string' && entry.source !== ''
        ? entry.source
        : marker > 0 ? key.slice(0, marker) : '';
      const remoteId = typeof entry.remoteId === 'string' && entry.remoteId !== ''
        ? entry.remoteId
        : marker > 0 ? key.slice(marker + 1) : '';
      if (remoteId === '') continue;
      return { ...entry, source, remoteId, key };
    }
    return undefined;
  }

  /**
   * Record one imported conversation and persist the map atomically.
   * @param key - `importKey()` value.
   * @param entry - metadata returned to the UI.
   * @returns the stored entry.
   */
  set(key, entry) {
    this.entries[key] = entry;
    this.save();
    return entry;
  }

  /** Persist the map atomically; failures only warn, never fail the import. */
  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      const payload = `${JSON.stringify(this.entries, null, 2)}\n`;
      writeFileSync(temporary, payload, 'utf8');
      try {
        renameSync(temporary, this.path);
      } catch {
        // Windows can refuse a rename over a file that another process or an
        // antivirus scanner briefly holds; fall back to in-place replacement.
        writeFileSync(this.path, payload, 'utf8');
      }
    } catch (error) {
      this.logger.warn?.(`dsh-agent-session-sync: failed to save imported map: ${String(error)}`);
    }
  }
}
