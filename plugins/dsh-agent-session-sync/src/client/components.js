import * as react from 'react';
import * as P from '@deepseek-ai/dsh-client-ui-primitives';
import { primitivesAvailable } from './runtime.js';
import { fmt, formatTime } from './utils.js';

const h = react.createElement;

/**
 * Where the sidebar will show an imported session.
 *
 * DSH groups by registered Workspace, so "which group did it land in" is the
 * one thing a user cannot infer from a successful import row. `workspace` is
 * absent on rows that never reached the write (skipped/failed) — those say
 * nothing rather than claim "未分组".
 *
 * @param row - one import result.
 * @param t - locale lookup.
 * @returns ` · prefix + label`, or '' when the row has no workspace verdict.
 */
function workspaceSuffix(row, t) {
  if (row.workspace === undefined) return '';
  if (row.workspace === null) return ' · ' + t('resultUngrouped');
  const name = typeof row.workspace.title === 'string' ? row.workspace.title : '';
  if (name === '') return '';
  const key = row.workspace.created === true ? 'resultWorkspaceNew' : 'resultWorkspace';
  return ' · ' + fmt(t(key), { name });
}

/**
 * How a successful import row describes what it did.
 *
 * A re-import no longer rewrites the session: it appends the turns the source
 * gained, so the row must say "merged, +N turns" rather than show a session id
 * that the user already has. `addedTurns === 0` is the honest "nothing new"
 * case and has its own wording — it looks like a failure otherwise.
 *
 * @param row - one import result.
 * @param t - locale lookup.
 * @returns the detail sentence.
 */
function resultDetail(row, t) {
  if (row.merged === true) {
    const added = typeof row.addedTurns === 'number' ? row.addedTurns : 0;
    return added > 0 ? fmt(t('resultMerged'), { n: added }) : t('resultMergedNone');
  }
  if (row.replaced === true) return t('resultReplaced');
  return row.sessionId ? row.sessionId.slice(0, 22) : t('resultOk');
}

    // ── small components ────────────────────────────────────────────────────

    /** A small status chip: the harness Tag when available. */
    export function Badge(props) {
      const tone = props.tone === 'ok' ? 'success' : props.tone === 'warn' ? 'warning' : 'neutral';
      if (primitivesAvailable.Tag) return h(P.Tag, { tone }, props.children);
      return h('span', { className: 'ci-badge' + (props.tone ? ' ' + props.tone : '') }, props.children);
    }

    /** One selectable conversation row. */
    export function ConversationRow(props) {
      const { item, checked, onToggle, t, nested } = props;
      const rowKey = typeof item.key === 'string' ? item.key : `${item.source ?? 'cursor'}:${item.id}`;
      const meta = [
        nested ? null : item.cwdLabel || t('unknownProject'),
        formatTime(item.updatedAt),
        // A few legacy conversations cannot report a count up front; the
        // import result carries the real number instead of a misleading 0.
        typeof item.messageCount === 'number' ? fmt(t('messages'), { n: item.messageCount }) : null,
      ].filter((part) => part !== null && part !== '');
      return h(
        'div',
        { className: 'ci-row' + (nested ? ' child' : ''), onClick: () => onToggle(rowKey), role: 'checkbox', 'aria-checked': checked, tabIndex: 0,
          onKeyDown: (event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              onToggle(rowKey);
            }
          } },
        h(P.Checkbox, { checked, onChange: () => onToggle(rowKey) }),
        h(
          'div',
          { className: 'ci-row-main' },
          h('div', { className: 'ci-row-title', title: item.title }, item.title),
          h('div', { className: 'ci-row-sub', title: item.cwd ?? undefined }, meta.join(', ')),
        ),
        h(
          'div',
          { className: 'ci-badges' },
          item.isArchived ? h(Badge, { tone: 'warn' }, t('archived')) : null,
          item.importedSessionId ? h(Badge, { tone: 'ok' }, t('imported')) : null,
        ),
      );
    }

    /** Simple determinate progress bar. */
    export function ProgressBar(props) {
      const total = props.total > 0 ? props.total : 0;
      const done = Math.max(0, Math.min(props.done, total));
      const percent = total === 0 ? (props.finished ? 100 : 0) : Math.round((done / total) * 100);
      const indeterminate = !props.finished && done === 0 && total > 0;
      return h(
        'div',
        { className: 'ci-progress-wrap' },
        h('div', { className: 'ci-progress' }, h('div', { className: 'ci-progress-inner' + (indeterminate ? ' indeterminate' : ''), style: indeterminate ? undefined : { width: `${percent}%` } })),
        h(
          'div',
          { className: 'ci-progress-line' },
          h('span', null, props.label),
          h('span', null, fmt(props.t('progress'), { done, total })),
        ),
      );
    }

    /** Import progress + result modal. */
    export function ImportModal(props) {
      const { t, open, status, cancelling, onClose, onCancel, onRetryFailed, labels } = props;
      if (!open) return null;
      const running = status === null || status.state === 'running';
      const results = status?.results ?? [];
      const okCount = results.filter((row) => row.ok === true && row.skipped !== true).length;
      const skipCount = results.filter((row) => row.skipped === true).length;
      const failCount = results.filter((row) => row.ok !== true && row.skipped !== true).length;
      const finished = status !== null && status.state !== 'running';
      const summary = finished ? fmt(t('doneSummary'), { ok: okCount, fail: failCount, skip: skipCount }) : null;
      const resultsList = results.length === 0 ? null : h(
        'div',
        { className: 'ci-results' },
        results.map((row) =>
          h(
            'div',
            { className: 'ci-result', key: `${row.source ?? 'cursor'}:${row.id}` },
            h('span', { className: 'ci-result-mark' }, row.skipped === true ? '–' : row.ok === true ? '✓' : '✗'),
            h(
              'span',
              { className: 'ci-result-text' },
              h('b', null, row.title),
              row.source ? ' [' + (labels?.[row.source] ?? row.source) + ']' : '',
              row.skipped === true
                ? ' — ' + t('resultSkip')
                : row.ok === true
                  ? ' — ' + resultDetail(row, t) + workspaceSuffix(row, t)
                  : ' — ' + (row.error ?? t('resultFail')),
              Array.isArray(row.warnings) && row.warnings.length > 0
                ? h('div', { className: 'ci-hint', style: { marginTop: 2 } }, row.warnings.join('；'))
                : null,
            ),
          ),
        ),
      );

      let body;
      if (status === null) {
        body = h('div', { className: 'ci-progress-wrap' }, h('div', { className: 'ci-current' }, t('preparing')));
      } else if (running) {
        body = h(
          'div',
          null,
          h(ProgressBar, { total: status.total, done: status.completed, label: status.current === null ? t('importing') : status.current.title, finished: false, t }),
          status.current === null ? null : h('div', { className: 'ci-current', style: { marginTop: 8 } }, status.current.title),
          resultsList,
        );
      } else {
        body = h(
          'div',
          null,
          h('div', { className: 'ci-current' }, status.state === 'cancelled' ? t('jobCancelled') : summary),
          status.state === 'failed' && status.error ? h('div', { className: 'ci-error', style: { marginTop: 10 } }, status.error) : null,
          resultsList,
          finished ? h('div', { className: 'ci-hint', style: { marginTop: 10 } }, t('afterHint')) : null,
        );
      }

      const footer = running
        ? h(P.Button, { variant: 'outline', onClick: cancelling ? undefined : onCancel, disabled: cancelling === true }, cancelling ? t('cancelling') : t('cancel'))
        : h(
            react.Fragment,
            null,
            failCount > 0 ? h(P.Button, { variant: 'outline', onClick: onRetryFailed, style: { marginRight: 8 } }, t('retryFailed')) : null,
            h(P.Button, { variant: 'primary', onClick: onClose }, t('close')),
          );

      return h(P.Modal, {
        open: true,
        onClose: () => {
          if (!running) onClose();
        },
        title: finished ? t('importDoneTitle') : t('importTitle'),
        closeLabel: t('close'),
        footer,
      }, body);
    }
