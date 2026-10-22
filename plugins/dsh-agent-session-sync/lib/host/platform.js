/**
 * Platform-specific path resolution for local agent data stores.
 *
 * Every provider reads data the desktop agent wrote for the current OS; this
 * module centralizes those conventions so the import pipeline stays portable
 * instead of hardcoding macOS directories.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Per-user application-data root for the current platform.
 * @param options - injectable platform/env/home for tests.
 * @returns absolute application-data directory.
 */
export function appDataRoot({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') return env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME ?? path.join(home, '.config');
}

/**
 * Cursor's Electron user-data directory (`User`).
 * macOS: ~/Library/Application Support/Cursor/User
 * Windows: %APPDATA%\Cursor\User
 * Linux: ~/.config/Cursor/User
 * @param options - injectable platform/env/home for tests.
 * @returns absolute Cursor user directory.
 */
export function cursorUserDir(options = {}) {
  return path.join(appDataRoot(options), 'Cursor', 'User');
}

/** Cursor's global SQLite storage directory. */
export function cursorGlobalStorageDir(options = {}) {
  return path.join(cursorUserDir(options), 'globalStorage');
}

/**
 * Directories where Kimi desktop may keep its Kimi Code sessions.
 * The desktop app is currently detected on macOS; Windows/Linux candidates are
 * best-effort and simply report the source as unavailable when absent.
 * @param options - injectable platform/env/home for tests.
 * @returns candidate directories.
 */
export function kimiAppSupportCandidates(options = {}) {
  const root = appDataRoot(options);
  const candidates = [path.join(root, 'kimi-desktop')];
  if ((options.platform ?? process.platform) === 'win32') {
    const local = options.env?.LOCALAPPDATA;
    if (typeof local === 'string' && local !== '') candidates.push(path.join(local, 'kimi-desktop'));
  }
  return candidates;
}

/**
 * Convert a `file://` URI into a filesystem path. Handles the Windows form
 * `file:///C:/Users/...`, whose decoded path starts with a slash before the
 * drive letter and would otherwise fail `path.isAbsolute` checks.
 * @param uri - file URI.
 * @returns absolute path, or null when the value is not a file URI.
 */
export function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  let value = decodeURIComponent(uri.slice('file://'.length));
  if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  return value;
}

/**
 * Whether a path is absolute on the current platform (accepts Windows drive and
 * UNC forms even when running under a different OS, which keeps data written on
 * another machine readable).
 * @param value - candidate path.
 * @returns true when the value is an absolute local path.
 */
export function isAbsoluteFilePath(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (path.isAbsolute(value)) return true;
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/**
 * Resolve a project directory, falling back to the user's home when the project
 * no longer exists or the value is not a local absolute path.
 * @param cwd - provider-reported working directory (may be a file:// URI).
 * @param options - injectable home/stat for tests.
 * @returns existing absolute directory or the home directory.
 */
export function resolveProjectCwd(cwd, { home = homedir(), stat = statSync } = {}) {
  const candidate = typeof cwd === 'string' && cwd.startsWith('file://') ? fileUriToPath(cwd) : cwd;
  if (isAbsoluteFilePath(candidate)) {
    try {
      if (stat(candidate).isDirectory()) return candidate;
    } catch {
      // The original project no longer exists: fall back to home.
    }
  }
  return home;
}

/**
 * The project directory a conversation actually belongs to.
 *
 * `resolveProjectCwd` always answers with *some* directory because a session
 * header needs one, which is why it falls back to home. That fallback is not a
 * workspace: registering it would invent a Workspace per user account and drag
 * every project-less conversation into it. This answers the narrower question
 * the workspace grouping asks — "does this conversation name a real project
 * directory?" — and returns undefined when it does not.
 *
 * Home is deliberately excluded: it is where project-less sessions land, so
 * treating it as a project would make "未分类" disappear from the sidebar.
 *
 * @param cwd - provider-reported working directory (may be a file:// URI).
 * @param options - injectable home/stat for tests.
 * @returns the existing project directory, or undefined.
 */
export function sourceProjectDirectory(cwd, { home = homedir(), stat = statSync } = {}) {
  const candidate = typeof cwd === 'string' && cwd.startsWith('file://') ? fileUriToPath(cwd) : cwd;
  if (!isAbsoluteFilePath(candidate)) return undefined;
  try {
    if (!stat(candidate).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  // Compare the trailing form so `C:\Users\me`, `C:/Users/me/` and a
  // duplicated-separator spelling (`C://Users//me`) all match: agents store
  // their cwd verbatim, and none of those variants is a different directory.
  const normalize = (value) => String(value)
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (normalize(candidate) === normalize(home)) return undefined;
  return candidate;
}

/**
 * The sqlite3 CLI binary used as a fallback when `node:sqlite` is unavailable.
 * Resolved through PATH (including `sqlite3.exe` on Windows) or `SQLITE3`.
 * @param env - environment to read.
 * @returns command name/path.
 */
export function sqlite3Command(env = process.env) {
  const override = typeof env.SQLITE3 === 'string' ? env.SQLITE3.trim() : '';
  return override === '' ? 'sqlite3' : override;
}

/**
 * Build a read-only SQLite `file:` URI that works on Windows and POSIX paths.
 * @param filePath - database file path.
 * @returns `file:` URI with `mode=ro`.
 */
export function sqliteFileUri(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  const prefixed = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
  return `file:${prefixed}?mode=ro`;
}

/**
 * Render an absolute path relative to the user's home for UI display.
 * @param value - absolute path.
 * @param home - home directory (injectable for tests).
 * @returns display-friendly path.
 */
export function displayHomePath(value, home = homedir()) {
  if (typeof value !== 'string' || value === '') return '';
  const normalizedHome = home.replace(/[\\/]+$/, '');
  if (value === normalizedHome) return '~';
  if (value.startsWith(`${normalizedHome}/`) || value.startsWith(`${normalizedHome}\\`)) {
    return `~${value.slice(normalizedHome.length)}`;
  }
  return value;
}
