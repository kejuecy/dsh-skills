import { NS, PANEL_ID } from './runtime.js';
import { zh, en } from './i18n.js';
import { SessionImportIcon } from './icons.js';
import { SessionImportPanel } from './panel.js';
import { injectStyles } from './styles.js';
import { rpcCall } from './utils.js';

/**
 * Services used before registration: the sessions store refreshes the sidebar
 * after an import; slots and layout provide the entry and page.
 */
export const inject = ['slots', 'locale', 'layout', 'sessions'];

/**
 * Read the sessions the DSH page itself lists.
 *
 * `ctx.sessions.list` is the very feed the session sidebar renders from, so
 * reading it is what "the sessions on the page" means — no guessing at
 * workspace directories on disk.
 *
 * Two kinds of row are skipped:
 *   - sub-agent children, which the page never lists as sessions of their own
 *     (they are only reachable through their parent row);
 *   - blank sessions, which carry no prompt yet and therefore have nothing to
 *     import — they used to sit in the list and fail only when the user hit
 *     "开始导入".
 *
 * @returns `{ available, ids }`; `available: false` when this DSH release has
 *   no session-list feed, in which case the caller must not filter at all.
 */
function readPageSessions(sessions) {
  const feed = sessions === undefined || sessions === null ? undefined : sessions.list;
  if (feed === undefined || feed === null || typeof feed.getSnapshot !== 'function') {
    return { available: false, ids: [] };
  }
  let byId;
  try {
    byId = feed.getSnapshot()?.byId ?? {};
  } catch {
    return { available: false, ids: [] };
  }
  const ids = [];
  for (const [id, row] of Object.entries(byId)) {
    if (typeof id !== 'string' || id === '') continue;
    if (row?.origin === 'subagent') continue;
    if (row?.blank === true) continue;
    ids.push(id);
  }
  return { available: true, ids };
}

/**
 * Watch the session list so the export page follows the page: a session the
 * user just created appears, a deleted one disappears.
 * @returns an unsubscribe function (a no-op when the feed cannot be watched).
 */
function watchPageSessions(sessions, listener) {
  const feed = sessions === undefined || sessions === null ? undefined : sessions.list;
  if (feed === undefined || feed === null || typeof feed.subscribe !== 'function') return () => {};
  try {
    return feed.subscribe(listener);
  } catch {
    return () => {};
  }
}

/**
 * Mount the browser half: dictionaries, sidebar entry and its page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx) {
  injectStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agent-session-sync: dictionaries');
  const t = ctx.locale.bind(NS);
  const rpc = (endpoint, payload) => rpcCall(endpoint, payload);

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 40,
    label: () => t('panel'),
    locale: NS,
  }, SessionImportIcon));

  // Refresh the sidebar's session catalog (and each imported session's title
  // projection) so imported conversations appear without a page reload.
  const refreshSessions = (results) => {
    const sessions = ctx.sessions;
    if (sessions === undefined) return;
    for (const result of results ?? []) {
      if (result?.ok === true && typeof result.sessionId === 'string') {
        sessions.refreshProjections(result.sessionId).catch(() => {});
      }
    }
    sessions.refresh().catch(() => {});
  };

  // One stable object identity: the slot `inject` callback may run on every
  // render, and a fresh object each time would make the panel tear down and
  // rebuild its subscription constantly.
  const pageSessions = {
    read: () => readPageSessions(ctx.sessions),
    subscribe: (listener) => watchPageSessions(ctx.sessions, listener),
  };

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({
      rpc,
      refreshSessions,
      // The export panel restricts its source list to what the page shows, so
      // it needs both the current read and the change feed.
      pageSessions,
    }),
  }, SessionImportPanel));
}
