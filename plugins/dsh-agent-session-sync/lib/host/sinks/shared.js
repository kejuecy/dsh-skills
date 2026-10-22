/**
 * Helpers shared by export sinks.
 *
 * A sink turns one neutral `Conversation` (the exact shape providers produce —
 * see `../providers/shared.js`) into a third-party agent's on-disk history.
 *
 * Contract every sink must satisfy:
 *
 *   export const id, label, description          // identity + panel tab text
 *   export const overwrite = true | false        // may replace an existing file
 *   export async function status()               // { available, location, error }
 *   export async function write(conversation, options) → WriteResult
 *
 *   WriteResult = {
 *     ok: true,
 *     target: string,        // absolute path (or DB key) that was written
 *     targetId: string,      // id the target agent will use for this transcript
 *     mode: 'created' | 'overwritten',
 *     backupPath?: string,   // set when an existing file was replaced
 *     bytes?: number,
 *     events?: number,
 *     notes?: string[],      // user-visible caveats (format downgrades, etc.)
 *   }
 *
 * Hard rules (the export service enforces the same ones):
 *  1. **Dry-run is the default.** `options.dryRun !== false` must not touch
 *     disk — return the plan instead (`{ ok: true, dryRun: true, ... }`).
 *  2. **Back up before overwriting.** Use `atomicWrite()` with `backup: true`.
 *  3. **Never write into a running app's live file.** Callers check
 *     `assertNotRunning()`; sinks must additionally never touch WAL/SHM files.
 *  4. **Downgrade loudly, never silently.** If the target format cannot carry a
 *     block (reasoning, unknown tool, attachment), flatten it to text and push a
 *     note describing what changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Maximum characters kept from one tool result when flattening. */
export const TOOL_RESULT_MAX_CHARS = 20_000;

/** Maximum characters kept from one reasoning block when flattening. */
export const REASONING_MAX_CHARS = 12_000;

/** Timestamp suffix used by every backup this plugin creates. */
export function backupStamp(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Ensure a directory exists. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Copy a file next to itself with a timestamp suffix.
 * @param file - existing file.
 * @returns backup path, or null when the source does not exist.
 */
export function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.bak-${backupStamp()}`;
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * Write a file atomically (temp + rename) with an optional backup.
 *
 * Renaming into place matters for agents that watch their transcript
 * directory: a half-written file would be read as a truncated session, whereas
 * a rename is atomic on the same volume.
 *
 * @param file - destination path.
 * @param content - string or Buffer.
 * @param options - `{ backup?: boolean, encoding?: string }`.
 * @returns `{ bytes, backupPath }`.
 */
export function atomicWrite(file, content, options = {}) {
  ensureDir(path.dirname(file));
  const backupPath = options.backup === false ? null : backupFile(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, options.encoding ?? 'utf8');
  try {
    fs.writeFileSync(tmp, data);
    // fsync the temp file so a crash right after rename cannot leave zeros.
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return { bytes: data.length, backupPath };
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Temp file may not exist; nothing to clean.
    }
    // A failed rename after a successful backup leaves the original intact.
    throw error;
  }
}

/**
 * Serialize objects as JSONL (one JSON document per line, trailing newline).
 * @param rows - row objects.
 * @returns file text.
 */
export function toJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length === 0 ? '' : '\n');
}

/** Normalize a timestamp to a non-negative integer (milliseconds). */
export function millis(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0) return Math.trunc(fallback);
  return Date.now();
}

/** Collapse whitespace and bound a title. */
export function oneLine(text, fallback, max = 160) {
  const value = typeof text === 'string' ? text.replaceAll(/\s+/g, ' ').trim() : '';
  if (value === '') return fallback;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Truncate with a visible marker. */
export function clamp(text, max, label) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} characters by ${label}]`;
}

/**
 * Flatten one run into a single plain-text message body.
 *
 * Used by targets whose transcript format carries no structured tool blocks
 * (or where a resumed conversation must not contain foreign tool-call ids).
 * Nothing is dropped: reasoning, calls and results all become text.
 *
 * @param run - normalized run.
 * @param options - `{ includeReasoning?: boolean }`.
 * @returns multi-line text ('' when the run is empty).
 */
export function flattenRun(run, options = {}) {
  const includeReasoning = options.includeReasoning !== false;
  const lines = [];
  for (const block of run.blocks ?? []) {
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim() !== '') lines.push(block.text);
    } else if (block.type === 'reasoning') {
      if (!includeReasoning) continue;
      const text = clamp(block.text ?? '', REASONING_MAX_CHARS, 'dsh-exporter');
      if (text.trim() !== '') lines.push(`【思考】${text}`);
    } else if (block.type === 'tool-call') {
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {});
      const short = args.length <= 4_000 ? args : `${args.slice(0, 4_000)}…`;
      lines.push(`[工具调用] ${block.name ?? 'tool'} ${short}`);
    }
  }
  for (const result of run.toolResults ?? []) {
    const output = clamp(result.output ?? '', TOOL_RESULT_MAX_CHARS, 'dsh-exporter');
    const prefix = result.isError === true ? '[工具结果: 错误]' : '[工具结果]';
    lines.push(`${prefix} ${output === '' ? '[没有输出]' : output}`);
  }
  return lines.filter((line) => typeof line === 'string' && line.trim() !== '').join('\n\n');
}

/** Extract the user text of one turn ('' when absent). */
export function userText(turn) {
  const blocks = turn.user?.content ?? [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Detect whether an executable is currently running.
 *
 * Writing a transcript that a live app has open is the single most destructive
 * thing an exporter can do: the app's in-memory state wins on the next flush and
 * the imported history is lost (or the session is corrupted). Callers must check
 * this before any non-dry-run write.
 *
 * @param exeName - Windows image name, e.g. `WorkBuddy.exe`.
 * @returns whether the process is running (false when it cannot be determined).
 */
export function isRunning(exeName) {
  if (process.platform !== 'win32') {
    // On POSIX, pgrep is universally available; a missing binary means unknown.
    try {
      const out = execFileSync('pgrep', ['-f', exeName], { encoding: 'utf8', timeout: 5_000 });
      return out.trim() !== '';
    } catch {
      return false;
    }
  }
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    return new RegExp(exeName.replaceAll('.', '\\.'), 'i').test(out);
  } catch {
    return false;
  }
}

/**
 * Throw when the target application is running and the caller did not force it.
 * @param exeName - image name to probe.
 * @param options - `{ force?: boolean, label?: string }`.
 */
export function assertNotRunning(exeName, options = {}) {
  if (options.force === true) return;
  if (!isRunning(exeName)) return;
  const label = options.label ?? exeName;
  const error = new Error(
    `${label} 正在运行，已拒绝写入。运行中的应用会持有会话文件并在下次保存时覆盖外部写入，` +
      `导致导入的内容丢失或会话损坏。请先完全退出 ${label} 后重试；确实要冒险写入可加 --force。`,
  );
  error.code = 'target-running';
  throw error;
}

/**
 * Encode an absolute cwd the way most agent CLIs name their project folder
 * (replace every separator and colon with a dash). Kept here so each sink uses
 * one consistent rule instead of re-inventing it.
 * @param cwd - absolute path.
 * @returns folder-safe name.
 */
export function encodeProjectDir(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return 'imported';
  const normalized = cwd.replace(/[\\/]+$/, '');
  const drive = /^([A-Za-z]):/.exec(normalized);
  let name = normalized.replace(/[\\/:]/g, '-');
  if (drive !== null) name = `${drive[1].toLowerCase()}${name.slice(1)}`;
  return name.replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'imported';
}
