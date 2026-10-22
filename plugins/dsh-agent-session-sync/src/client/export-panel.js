/**
 * "Import into another agent" panel — the second of the plugin's two directions.
 *
 * Both directions are imports, each seen from the receiving side. The first
 * panel imports third-party history *into DSH*; this one imports DSH sessions
 * *into a third-party agent* on the same machine.
 *
 * The internal names stay `export`/`sink` because that is what the code does to
 * the DSH side, but every string the user sees says "import" so the two panels
 * read as one symmetric feature rather than "the main one plus a reverse".
 *
 * ── Why there is no "preview" button ────────────────────────────────────────
 *
 * The Host refuses to write until the caller sends `confirm: true`, which is
 * what keeps a stray click away from another agent's files. The old panel made
 * that a user-visible step: click 预览, read the plan, click 写入.
 *
 * The plan does not need a button. It is derived from (session, target, mode),
 * so the panel now fetches it automatically and keeps it on screen next to the
 * write action — the same information, one click fewer. The safety property is
 * unchanged and in fact stricter: `confirm: true` is only ever sent for a plan
 * that is on screen *for the current settings*, so a stale plan (change the
 * session, the target or the mode) disables the button instead of quietly
 * writing something the user never saw.
 *
 * ── Write is an upsert ─────────────────────────────────────────────────────
 *
 * The target session id is derived from the source session id (see the
 * WorkBuddy sink), so exporting the same conversation twice means "update the
 * one you already have", not "add a copy". There is no branch for the user to
 * choose: exists → replace in place (old file backed up first), missing →
 * create. The plan says which of the two will happen; it does not ask.
 */
import * as react from 'react';
import * as P from '@deepseek-ai/dsh-client-ui-primitives';
import { Badge } from './components.js';
import { SOURCE_ICONS } from './icons.js';
import { EXPORT_ROUTE_PREFIX, primitivesAvailable } from './runtime.js';
import { fmt, formatTime, rpcCall } from './utils.js';

const h = react.createElement;

const callExport = (endpoint, payload) => rpcCall(endpoint, payload, EXPORT_ROUTE_PREFIX);

/** How long to wait after the last input change before re-checking the plan. */
const PLAN_DEBOUNCE_MS = 220;

/** One radio-style card describing a writable target. */
function TargetCard(props) {
  const { target, selected, onSelect, t } = props;
  const disabled = target.available !== true;
  return h(
    'div',
    {
      className: 'ci-row' + (selected ? ' selected' : '') + (disabled ? ' disabled' : ''),
      role: 'radio',
      'aria-checked': selected,
      'aria-disabled': disabled,
      tabIndex: disabled ? -1 : 0,
      title: target.location ?? target.error ?? undefined,
      onClick: () => {
        if (!disabled) onSelect(target.id);
      },
      onKeyDown: (event) => {
        if (disabled) return;
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          onSelect(target.id);
        }
      },
    },
    h(P.Radio === undefined ? 'input' : P.Radio, {
      type: P.Radio === undefined ? 'radio' : undefined,
      checked: selected,
      disabled,
      onChange: () => {
        if (!disabled) onSelect(target.id);
      },
    }),
    h(
      'div',
      { className: 'ci-row-main' },
      h(
        'div',
        { className: 'ci-row-title' },
        SOURCE_ICONS[target.id] !== undefined
          ? h('img', { className: 'ci-target-icon', src: SOURCE_ICONS[target.id], alt: '' })
          : null,
        target.label,
      ),
      h(
        'div',
        { className: 'ci-row-sub' },
        disabled ? (target.error ?? t('exportUnavailable')) : target.description ?? '',
      ),
    ),
    h(
      'div',
      { className: 'ci-badges' },
      disabled ? h(Badge, { tone: 'warn' }, t('exportUnavailable')) : null,
    ),
  );
}

/** One selectable DSH session (single selection — export is per session). */
function SourceRow(props) {
  const { item, selected, onSelect, t } = props;
  const meta = [item.cwdLabel || item.cwd || t('unknownProject'), formatTime(item.updatedAt)].filter(
    (part) => typeof part === 'string' && part !== '',
  );
  return h(
    'div',
    {
      className: 'ci-row' + (selected ? ' selected' : ''),
      role: 'radio',
      'aria-checked': selected,
      tabIndex: 0,
      onClick: () => onSelect(item.id),
      onKeyDown: (event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          onSelect(item.id);
        }
      },
    },
    h(P.Radio === undefined ? 'input' : P.Radio, {
      type: P.Radio === undefined ? 'radio' : undefined,
      checked: selected,
      onChange: () => onSelect(item.id),
    }),
    h(
      'div',
      { className: 'ci-row-main' },
      h('div', { className: 'ci-row-title', title: item.title }, item.title),
      h('div', { className: 'ci-row-sub' }, meta.join(', ')),
    ),
    h(
      'div',
      { className: 'ci-badges' },
      typeof item.messageCount === 'number' ? h(Badge, null, fmt(t('messages'), { n: item.messageCount })) : null,
    ),
  );
}

/**
 * The write summary: what this (session, target, mode) will actually do.
 *
 * It is information, not a permission dialog. The target session id comes from
 * the source session, so the plan already knows whether this is a first export
 * or a refresh, and the backend overwrites in place with a backup either way.
 * Asking the user to re-confirm an update would only make the common case —
 * re-exporting a conversation that already exists — cost an extra click.
 */
function PlanCard(props) {
  const { t, plan, written } = props;
  if (plan.phase === 'idle') return null;
  if (plan.phase === 'loading' && plan.data === null) {
    return h('div', { className: 'ci-plan' }, h('div', { className: 'ci-plan-line muted' }, t('exportChecking')));
  }
  if (plan.phase === 'error') {
    return h('div', { className: 'ci-plan bad' }, h('div', { className: 'ci-plan-line' }, fmt(t('exportCheckFail'), { message: plan.error })));
  }
  const data = plan.data ?? {};
  const exists = data.exists === true;
  return h(
    'div',
    { className: 'ci-plan' + (written ? ' done' : '') },
    h(
      'div',
      { className: 'ci-plan-head' },
      h('strong', null, written ? t('exportDoneTitle') : t('exportPlanTitle')),
      h(
        Badge,
        { tone: exists ? 'warn' : 'ok' },
        written
          ? exists ? t('exportUpdated') : t('exportCreated')
          : exists ? t('exportWillUpdate') : t('exportWillCreate'),
      ),
      plan.phase === 'loading' && !written ? h('span', { className: 'ci-plan-busy' }, t('exportChecking')) : null,
    ),
    data.source?.title !== undefined ? h('div', { className: 'ci-plan-line strong' }, data.source.title) : null,
    typeof data.rows === 'number'
      ? h('div', { className: 'ci-plan-line' }, fmt(t('exportSummary'), { rows: data.rows, messages: data.messages ?? 0 }))
      : null,
    data.target !== undefined ? h('div', { className: 'ci-plan-line muted path' }, data.target) : null,
    // Upsert needs no switch: the id is derived from the source session, so
    // "exists" already means "this is the same conversation". Say what will
    // happen and mention the backup, instead of asking for permission.
    exists && !written ? h('div', { className: 'ci-plan-line muted' }, t('exportUpdateNote')) : null,
    written
      ? h(
          'div',
          { className: 'ci-plan-line muted' },
          data.backupPath === undefined || data.backupPath === null
            ? t('exportNoBackup')
            : fmt(t('exportBackup'), { path: data.backupPath }),
        )
      : null,
    Array.isArray(data.notes) && data.notes.length > 0
      ? h('ul', { className: 'ci-plan-notes' }, data.notes.map((note, index) => h('li', { key: index }, note)))
      : null,
  );
}

/**
 * Compare two id lists without caring about order — the page feed may reorder
 * rows while the same sessions are listed, and a reorder must not refetch.
 */
function sameIds(a, b) {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((id) => seen.has(id));
}

/**
 * Snapshot the page scope once.
 *
 * Never throws: a DSH release without a session-list feed must degrade to "no
 * filter", because a plugin that cannot read the page should still be able to
 * list sessions rather than showing an empty column.
 *
 * @param feed - `{ read, subscribe }` handed down from the browser half.
 * @returns `{ available, ids }`.
 */
function readScope(feed) {
  if (feed === undefined || feed === null || typeof feed.read !== 'function') return { available: false, ids: [] };
  try {
    const value = feed.read();
    if (value === null || typeof value !== 'object') return { available: false, ids: [] };
    return { available: value.available === true, ids: Array.isArray(value.ids) ? value.ids : [] };
  } catch {
    return { available: false, ids: [] };
  }
}

/** Read an error the same way everywhere on this panel. */
function messageOf(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Render the export page.
 * @param props - `{ t, loadList, pageSessions }`; `loadList` refreshes the
 *   sidebar counts after a successful write so the two directions stay
 *   consistent, and `pageSessions` is the page's session feed used to keep the
 *   source column limited to sessions the DSH page actually lists.
 */
export function ExportPanel(props) {
  const { t } = props;

  // Read once at mount so the very first request already carries the scope;
  // otherwise the panel would list every session on disk for one frame before
  // correcting itself.
  const [scope, setScope] = react.useState(() => readScope(props.pageSessions));
  const [sources, setSources] = react.useState({ phase: 'loading', data: null, error: null, meta: null });
  const [targets, setTargets] = react.useState({ phase: 'loading', data: null, error: null });
  const [sourceId, setSourceId] = react.useState('');
  const [targetId, setTargetId] = react.useState('');
  const [mode, setMode] = react.useState('full');
  /**
   * Compress the transcript when it is larger than the model window. On by
   * default: the alternative is a session that cannot be resumed at all.
   */
  const [compress, setCompressInner] = react.useState(() => {
    try {
      return globalThis.localStorage?.getItem('session-export:compress') !== 'off';
    } catch {
      return true;
    }
  });
  const setCompress = react.useCallback((next) => {
    setCompressInner(next);
    try {
      globalThis.localStorage?.setItem('session-export:compress', next ? 'auto' : 'off');
    } catch {
      // Preference only.
    }
  }, []);
  const [search, setSearch] = react.useState('');
  /** `{ phase, key, data, error }` — the auto-fetched plan and which inputs it describes. */
  const [plan, setPlan] = react.useState({ phase: 'idle', key: '', data: null, error: '' });
  const [written, setWritten] = react.useState(false);
  const [busy, setBusy] = react.useState(false);
  const [error, setError] = react.useState('');
  /** Guards against a slow response overwriting a newer one. */
  const planSeq = react.useRef(0);

  /**
   * Load the source list.
   * @param ids - session ids the page lists, or `null` to list everything
   *   (only when this DSH release has no session-list feed at all).
   */
  const loadSources = react.useCallback(async (ids) => {
    // Keep the previous rows on screen while reloading: the page feed ticks
    // whenever a session starts or stops running, and blanking the column on
    // every tick would make it flicker.
    setSources((current) => ({ phase: 'loading', data: current.data, error: null, meta: current.meta }));
    try {
      const value = await callExport('sources', ids === null ? {} : { ids });
      const list = Array.isArray(value?.conversations) ? value.conversations : [];
      setSources({
        phase: 'ready',
        data: list,
        error: null,
        meta: {
          pageOnly: value?.pageOnly === true,
          total: typeof value?.total === 'number' ? value.total : list.length,
          hidden: typeof value?.hidden === 'number' ? value.hidden : 0,
        },
      });
      setSourceId((current) => (current !== '' && list.some((row) => row.id === current) ? current : (list[0]?.id ?? '')));
    } catch (failure) {
      setSources({ phase: 'error', data: null, error: messageOf(failure), meta: null });
    }
  }, []);

  const loadTargets = react.useCallback(async () => {
    setTargets({ phase: 'loading', data: null, error: null });
    try {
      const value = await callExport('targets');
      const list = Array.isArray(value?.targets) ? value.targets : [];
      setTargets({ phase: 'ready', data: list, error: null });
      const firstUsable = list.find((row) => row.available === true);
      setTargetId((current) => {
        if (current !== '' && list.some((row) => row.id === current && row.available === true)) return current;
        return firstUsable?.id ?? '';
      });
    } catch (failure) {
      setTargets({ phase: 'error', data: null, error: messageOf(failure) });
    }
  }, []);

  react.useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  // Follow the page's own session feed: a session created while this panel is
  // open must appear, and a deleted one must disappear. Only a *different set*
  // of ids triggers a reload, so the feed's frequent ticks stay cheap.
  react.useEffect(() => {
    const feed = props.pageSessions;
    if (feed === undefined || feed === null || typeof feed.subscribe !== 'function') return undefined;
    return feed.subscribe(() => {
      const next = readScope(feed);
      setScope((current) =>
        current.available === next.available && sameIds(current.ids, next.ids) ? current : next,
      );
    });
  }, [props.pageSessions]);

  // `scopeKey` encodes the id set itself, so the request is re-issued only when
  // the page's list of sessions really changed.
  const scopeKey = scope.available ? `page:${scope.ids.length}:${[...scope.ids].sort().join(',')}` : 'all';

  react.useEffect(() => {
    void loadSources(scope.available ? scope.ids : null);
  }, [scopeKey, loadSources]);

  /**
   * Everything the plan depends on. A plan is only usable when it was computed
   * for this exact key, which is what makes "confirm" honest: the user cannot
   * write a session/target/mode combination they have not been shown.
   */
  const compressMode = compress ? 'auto' : 'off';
  const planKey = `${sourceId}\u0000${targetId}\u0000${mode}\u0000${compressMode}`;

  react.useEffect(() => {
    setError('');
    if (sourceId === '' || targetId === '') {
      planSeq.current += 1;
      setPlan({ phase: 'idle', key: '', data: null, error: '' });
      setWritten(false);
      return undefined;
    }
    const seq = ++planSeq.current;
    // A previous plan for the same key stays visible while re-checking; a plan
    // for different inputs must never linger next to the write button.
    setPlan((current) => ({
      phase: 'loading',
      key: planKey,
      data: current.key === planKey ? current.data : null,
      error: '',
    }));
    setWritten(false);
    const timer = setTimeout(async () => {
      try {
        // Same options the write will use, minus `confirm`: this is what makes
        // the plan trustworthy — it is the write's own code path with the write
        // switched off, not a separate approximation of it.
        const value = await callExport('export', {
          sourceId,
          targetId,
          mode,
          compress: compressMode,
          overwrite: true,
          confirm: false,
        });
        if (seq !== planSeq.current) return;
        setPlan({ phase: 'ready', key: planKey, data: value ?? null, error: '' });
      } catch (failure) {
        if (seq !== planSeq.current) return;
        setPlan({ phase: 'error', key: planKey, data: null, error: messageOf(failure) });
      }
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [planKey, sourceId, targetId, mode, compressMode]);

  const sourceList = Array.isArray(sources.data) ? sources.data : [];
  const needle = search.trim().toLowerCase();
  const visibleSources = needle === ''
    ? sourceList
    : sourceList.filter(
        (row) => String(row.title ?? '').toLowerCase().includes(needle) || String(row.cwd ?? '').toLowerCase().includes(needle),
      );
  const targetList = Array.isArray(targets.data) ? targets.data : [];
  const currentTarget = targetList.find((row) => row.id === targetId);
  const targetLabel = currentTarget?.label ?? targetId;

  /** The plan on screen describes the current inputs. */
  const planCurrent = plan.phase === 'ready' && plan.key === planKey && plan.data !== null;
  const canWrite = sourceId !== '' && targetId !== '' && planCurrent && !busy;

  const run = async () => {
    if (canWrite !== true) return;
    setBusy(true);
    setError('');
    try {
      // `overwrite: true` is what makes this an upsert: the id is derived from
      // the source session, so the backend either creates that session or
      // replaces it in place (backing the old file up first). There is no
      // third outcome to choose between, so the panel does not ask.
      const value = await callExport('export', { sourceId, targetId, mode, compress: compressMode, overwrite: true, confirm: true });
      setPlan({ phase: 'ready', key: planKey, data: value ?? null, error: '' });
      setWritten(true);
      // The import sidebar shows DSH session counts; a write changes nothing
      // there, but a successful export is the moment to refresh anyway so a
      // later re-export reflects the new file state.
      if (typeof props.loadList === 'function') props.loadList(true);
    } catch (failure) {
      setError(fmt(t('exportFailed'), { message: messageOf(failure) }));
      setWritten(false);
    } finally {
      setBusy(false);
    }
  };

  const modeControl = primitivesAvailable.SegmentedTabs
    ? h(P.SegmentedTabs, {
        value: mode,
        onChange: (next) => setMode(next),
        label: t('exportModeLabel'),
        items: [
          { value: 'full', label: t('exportModeFull'), id: 'session-export-mode-full' },
          { value: 'flat', label: t('exportModeFlat'), id: 'session-export-mode-flat' },
        ],
      })
    : h(
        react.Fragment,
        null,
        ['full', 'flat'].map((value) =>
          h(
            'button',
            {
              key: value,
              type: 'button',
              title: value === 'full' ? t('exportModeFullHint') : t('exportModeFlatHint'),
              className: 'ci-mode' + (mode === value ? ' active' : ''),
              onClick: () => setMode(value),
            },
            value === 'full' ? t('exportModeFull') : t('exportModeFlat'),
          ),
        ),
      );

  const loadingSources = sources.phase === 'loading';
  const loadingTargets = targets.phase === 'loading';
  const noTargets = targets.phase === 'ready' && targetList.filter((row) => row.available === true).length === 0;

  // Tell the user *why* the column is shorter than the sessions on disk: the
  // scope follows the page, and silently dropping rows would look like a bug.
  const scopeNote = sources.meta === null
    ? null
    : h(
        'div',
        { className: 'ci-scope-note' },
        sources.meta.pageOnly === true
          ? fmt(t('exportPageOnly'), { shown: sourceList.length, total: sources.meta.total })
          : fmt(t('exportPageAll'), { total: sources.meta.total }),
      );

  /** Why the write button is disabled, in the user's words. */
  let actionHint = null;
  if (sourceId === '') actionHint = t('exportNoSource');
  else if (targetId === '') actionHint = noTargets ? t('exportNoTarget') : null;
  else if (plan.phase === 'loading') actionHint = t('exportChecking');
  else if (plan.phase === 'error') actionHint = t('exportCheckHint');

  return h(
    'div',
    { className: 'ci-export' },
    h('div', { className: 'ci-export-head' }, h('p', { className: 'ci-sub' }, t('exportSubtitle'))),

    error !== '' ? h('div', { className: 'ci-error' }, error) : null,

    h(
      'div',
      { className: 'ci-export-body' },
      h(
        'div',
        { className: 'ci-export-grid' },
        // ── source column ────────────────────────────────────────────────────
        h(
          'div',
          { className: 'ci-export-col' },
          h('div', { className: 'ci-col-head' }, t('exportSource')),
          h(P.Input === undefined ? 'input' : P.Input, {
            className: 'ci-search',
            placeholder: t('searchPlaceholder'),
            value: search,
            onChange: (event) => setSearch(event.target.value),
          }),
          scopeNote,
          // Show the hint only before the first page of rows arrives; a reload
          // keeps the previous rows visible instead of blinking the column out.
          loadingSources && sources.data === null
            ? h('div', { className: 'ci-loading-hint' }, t('scanningSources'))
            : sources.phase === 'error'
              ? h('div', { className: 'ci-error' }, fmt(t('exportSourceLoadFail'), { message: String(sources.error) }))
              : visibleSources.length === 0
                ? h('div', { className: 'ci-empty' },
                    sources.meta !== null && sources.meta.pageOnly === true && sourceList.length === 0
                      ? t('exportPageEmpty')
                      : t('noMatch'))
                : h(
                    'div',
                    { className: 'ci-list', role: 'radiogroup' },
                    visibleSources.map((item) =>
                      h(SourceRow, { key: item.id, item, selected: item.id === sourceId, onSelect: setSourceId, t })),
                  ),
        ),

        // ── target column ────────────────────────────────────────────────────
        h(
          'div',
          { className: 'ci-export-col' },
          h('div', { className: 'ci-col-head' }, t('exportTarget')),
          loadingTargets
            ? h('div', { className: 'ci-loading-hint' }, t('scanningSources'))
            : targets.phase === 'error'
              ? h('div', { className: 'ci-error' }, fmt(t('exportTargetsFail'), { message: String(targets.error) }))
              : noTargets
                ? h('div', { className: 'ci-empty' }, t('exportNoTarget'))
                : h(
                    'div',
                    { className: 'ci-list', role: 'radiogroup' },
                    targetList.map((item) =>
                      h(TargetCard, { key: item.id, target: item, selected: item.id === targetId, onSelect: setTargetId, t })),
                  ),

          h(
            'div',
            { className: 'ci-export-options' },
            modeControl,
            h(
              'label',
              { className: 'ci-toggle', title: t('compressHint') },
              h(P.Checkbox, { checked: compress, onChange: () => setCompress(!compress) }),
              h('span', null, t('compressLabel')),
            ),
          ),
        ),
      ),

      // The plan sits under both columns: it describes the *pair*, not either side.
      h(PlanCard, { t, plan, written }),
    ),

    h(
      'div',
      { className: 'ci-export-actions' },
      actionHint === null ? null : h('span', { className: 'ci-hint' }, actionHint),
      h('span', { className: 'ci-group-spacer' }),
      // The host's own button, so this page and the import page share one look.
      // The raw `<button>` is the forward-compatibility fallback.
      primitivesAvailable.Button
        ? h(
            P.Button,
            { variant: 'primary', disabled: canWrite !== true, onClick: () => void run() },
            busy ? t('exportRunning') : fmt(t('exportRunTo'), { target: targetLabel }),
          )
        : h(
            'button',
            {
              type: 'button',
              className: 'ci-btn primary',
              disabled: canWrite !== true,
              onClick: () => void run(),
            },
            busy ? t('exportRunning') : fmt(t('exportRunTo'), { target: targetLabel }),
          ),
    ),
  );
}
