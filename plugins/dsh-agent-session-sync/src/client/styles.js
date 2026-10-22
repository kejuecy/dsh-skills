    // ── styles ──────────────────────────────────────────────────────────────
export const CSS = [
      '.ci-page{display:flex;flex-direction:column;height:100%;min-height:0;padding:24px 28px 18px;gap:14px;color:var(--dsw-alias-label-primary,#1f2329)}',
      // `container-type` lets the page react to *its own* width instead of the
      // window's: the same panel renders wide in the main area and narrow in the
      // sidebar, and only the container knows which.
      '.ci-layout{display:flex;gap:16px;flex:1;min-height:0;overflow:hidden;container-type:inline-size;container-name:importpage}',
      // Narrow (sidebar): the source rail becomes a horizontal strip of chips so
      // the conversation list keeps the full width instead of being squeezed
      // into a column half its normal size.
      '@container importpage (max-width:620px){',
      ' .ci-layout{flex-direction:column;overflow:auto}',
      ' .ci-rail{width:auto;flex-shrink:0;flex-direction:row;gap:6px;overflow-x:auto;overflow-y:hidden;padding-bottom:2px}',
      ' .ci-rail-label{display:none}',
      ' .ci-rail-row{width:auto;flex:0 0 auto;border:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:999px;padding:4px 10px 4px 6px;gap:6px}',
      ' .ci-rail-row-meta{display:none}',
      ' .ci-main{min-height:0}',
      '}',
      '.ci-rail{width:224px;flex-shrink:0;display:flex;flex-direction:column;gap:2px;overflow:auto;padding:2px}',
      '.ci-loading{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:24px 0}',
      '.ci-loading-card{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:420px;width:100%}',
      '.ci-spinner{display:inline-flex;color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.ci-spinner svg{animation:ci-spin 1s linear infinite}',
      '@keyframes ci-spin{to{transform:rotate(360deg)}}',
      '.ci-loading-title{font-size:14px;line-height:20px;font-weight:600}',
      '.ci-loading-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919c);text-align:center}',
      '.ci-skeleton-list{display:flex;flex-direction:column;gap:10px;width:100%;margin-top:10px}',
      '.ci-skel-line{height:12px;border-radius:6px;background:var(--dsw-alias-bg-l3,#e9eaee);animation:ci-pulse 1.4s ease-in-out infinite}',
      '@keyframes ci-pulse{0%,100%{opacity:.5}50%{opacity:1}}',
      '.ci-rail-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919c);padding:0 8px 6px}',
      '.ci-rail-row{display:flex;align-items:center;gap:9px;width:100%;text-align:left;font:inherit;cursor:pointer;border:0.5px solid transparent;border-radius:8px;padding:7px 8px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.ci-rail-row:hover{background:var(--dsw-alias-bg-l2,rgba(0,0,0,.03))}',
      '.ci-rail-row.active{background:var(--dsw-alias-bg-l3,#e9eaee)}',
      '.ci-rail-row.unavailable{opacity:.55;cursor:not-allowed}',
      '.ci-rail-row-icon{width:24px;height:24px;flex-shrink:0;border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-l3,#e9eaee)}',
      '.ci-rail-row-main{display:flex;flex-direction:column;flex:1;min-width:0}',
      '.ci-rail-row-name{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ci-rail-row-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a919c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ci-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}',
      '.ci-main-head{display:flex;align-items:center;gap:10px;min-height:34px}',
      '.ci-main-head-icon{width:28px;height:28px;flex-shrink:0;border-radius:7px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-l3,#e9eaee)}',
      '.ci-main-head-title{font-size:15px;line-height:20px;font-weight:600}',
      '.ci-main-head-sub{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a919c)}',

      '.ci-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.ci-title{margin:0;font-size:18px;line-height:26px;font-weight:600}',
      '.ci-sub{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.ci-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.ci-source-icon-img{width:28px;height:28px;display:block;object-fit:cover}',
      '.ci-foot-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
      '.ci-mode{font:inherit;font-size:12px;line-height:18px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary,#5c626b);border:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:8px;padding:2px 9px}',
      '.ci-mode.active{color:var(--dsw-alias-label-primary,#1f2329);border-color:currentColor;background:var(--dsw-alias-bg-l2,rgba(0,0,0,.04))}',
      '.ci-grow{flex:1;min-width:160px}',
      '.ci-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919c);white-space:nowrap}',
      '.ci-list{flex:1;min-height:0;overflow:auto;border:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:10px}',
      '.ci-group{border-bottom:0.5px solid var(--dsw-alias-border-l2,#e5e6eb)}',
      '.ci-group:last-child{border-bottom:none}',
      '.ci-group-head{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;background:var(--dsw-alias-bg-l2,rgba(0,0,0,.02))}',
      '.ci-group-head:hover{background:var(--dsw-alias-bg-l3,rgba(0,0,0,.05))}',
      '.ci-chevron{width:14px;flex-shrink:0;color:var(--dsw-alias-label-tertiary,#8a919c);font-size:11px;line-height:1}',
      '.ci-folder{flex-shrink:0;width:16px;height:16px;color:var(--dsw-alias-label-secondary,#5c626b)}',
      '.ci-group-name{font-size:13px;line-height:20px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ci-group-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a919c);white-space:nowrap}',
      '.ci-group-spacer{flex:1}',
      '.ci-group-check{display:flex;align-items:center;padding-left:4px;flex-shrink:0}',
      '.ci-row.child{padding-left:36px}',
      '.ci-row{display:flex;align-items:flex-start;gap:12px;padding:11px 14px;border-bottom:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);cursor:pointer}',
      '.ci-row:last-child{border-bottom:none}',
      '.ci-row:hover{background:var(--dsw-alias-bg-l2,rgba(0,0,0,.03))}',
      '.ci-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.ci-row-title{font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ci-target-icon{width:20px;height:20px;flex-shrink:0;border-radius:5px;margin-right:7px;vertical-align:-4px;background:var(--dsw-alias-bg-l3,#e9eaee);object-fit:cover;display:inline-block}',
      '.ci-row-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ci-badges{display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;max-width:40%}',
      '.ci-badge{font-size:11px;line-height:16px;padding:1px 7px;border-radius:9px;border:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);color:var(--dsw-alias-label-secondary,#5c626b);white-space:nowrap}',
      '.ci-badge.ok{color:var(--dsw-alias-state-success-primary,#1f9d55);border-color:currentColor}',
      '.ci-badge.warn{color:var(--dsw-alias-state-warning-primary,#c98a00);border-color:currentColor}',
      // The action bar stays put: same treatment as the export page, so the
      // primary button is always where the eye expects it.
      '.ci-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;flex-shrink:0;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l2,#e5e6eb)}',
      '.ci-empty{padding:40px 16px;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.ci-error{padding:14px 16px;border-radius:10px;border:0.5px solid var(--dsw-alias-state-error-primary,#d93026);background:rgba(217,48,38,.06);font-size:13px;line-height:20px}',
      '.ci-progress-wrap{display:flex;flex-direction:column;gap:8px;width:100%;min-width:0;box-sizing:border-box}',
      '.ci-progress{height:6px;flex-shrink:0;border-radius:3px;background:var(--dsw-alias-bg-l3,#e9eaee);overflow:hidden}',
      '.ci-progress-inner{height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary,#4d6bfe);transition:width .25s ease}',
      '.ci-progress-line{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.ci-progress-line>span{min-width:0;overflow-wrap:anywhere}',
      '.ci-progress-line>span:last-child{white-space:nowrap;flex-shrink:0}',
      '.ci-progress-inner.indeterminate{width:30%;animation:ci-slide 1.2s ease-in-out infinite}',
      '@keyframes ci-slide{0%{margin-left:0}50%{margin-left:70%}100%{margin-left:0}}',
      '.ci-current{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ci-results{max-height:260px;overflow:auto;margin-top:12px;display:flex;flex-direction:column;gap:6px}',
      '.ci-result{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px}',
      '.ci-result-mark{flex-shrink:0;width:14px;text-align:center}',
      '.ci-result-text{flex:1;min-width:0;overflow-wrap:anywhere}',
      '.ci-result-text b{font-weight:500}',
      '.ci-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919c)}',

      // ── direction tabs ─────────────────────────────────────────────────────
      '.ci-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-line-regular,#e5e6eb)}',
      '.ci-tab{appearance:none;border:0;background:transparent;padding:8px 12px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;color:var(--dsw-alias-label-secondary,#4e5969);border-bottom:2px solid transparent;margin-bottom:-1px}',
      '.ci-tab:hover{color:var(--dsw-alias-label-primary,#1f2329)}',
      '.ci-tab.active{color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#2f6bff)}',
      '.ci-tab-count{margin-left:6px;font-size:11px;line-height:16px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-l3,#e9eaee);color:var(--dsw-alias-label-secondary,#5c626b)}',
      '.ci-tab.active .ci-tab-count{background:var(--dsw-alias-fill-secondary,rgba(47,107,255,.12));color:var(--dsw-alias-brand-primary,#2f6bff)}',
      '.ci-empty-actions{margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}',

      // ── export page ────────────────────────────────────────────────────────
      // Everything below is scoped under `.ci-export`. Unscoped duplicates of
      // `.ci-list` / `.ci-empty` / `.ci-error` used to be declared here as well,
      // and because they came later in the sheet they overrode the import page:
      // its conversation list was capped at 340px and its empty states shrank.
      '.ci-export{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0}',
      '.ci-export-head{display:flex;flex-direction:column;gap:4px;flex-shrink:0}',
      '.ci-export-body{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow:auto;padding-right:2px}',
      '.ci-export-grid{display:flex;gap:16px;min-height:0;flex-wrap:wrap}',
      '.ci-export-col{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:8px}',
      '.ci-export .ci-col-head{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary,#4e5969)}',
      '.ci-export .ci-list{flex:0 1 auto;display:flex;flex-direction:column;gap:2px;overflow:auto;max-height:300px;padding:2px;border:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:10px}',
      '.ci-export .ci-row{padding:9px 12px;border-bottom:none;border-radius:6px}',
      '.ci-export .ci-row.selected{background:var(--dsw-alias-fill-secondary,rgba(47,107,255,.08));border-radius:6px}',
      '.ci-export .ci-row.disabled{opacity:.55;cursor:not-allowed}',
      '.ci-export .ci-empty{padding:14px 4px;font-size:12px}',
      '.ci-export .ci-error{padding:10px 12px;font-size:12px;border-radius:8px}',
      '.ci-export-options{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.ci-export-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex-shrink:0;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l2,#e5e6eb)}',
      '.ci-btn{appearance:none;border:1px solid var(--dsw-alias-line-regular,#d0d3d9);background:var(--dsw-alias-bg-primary,#fff);color:inherit;font:inherit;font-size:13px;line-height:20px;padding:6px 14px;border-radius:6px;cursor:pointer}',
      '.ci-btn:hover:not(:disabled){border-color:var(--dsw-alias-line-strong,#a9aeb8)}',
      '.ci-btn.primary{background:var(--dsw-alias-brand-primary,#2f6bff);border-color:transparent;color:#fff;white-space:nowrap}',
      '.ci-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.ci-plan{border:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:5px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-l2,rgba(0,0,0,.02))}',
      '.ci-plan.done{border-color:var(--dsw-alias-state-success-primary,#1f9d55)}',
      '.ci-plan.bad{border-color:var(--dsw-alias-state-error-primary,#d93026);background:rgba(217,48,38,.06)}',
      '.ci-plan-head{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px}',
      '.ci-plan-busy{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.ci-plan-line{overflow-wrap:anywhere}',
      '.ci-plan-line.strong{font-weight:500;font-size:13px;line-height:20px}',
      '.ci-plan-line.muted{color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.ci-plan-line.path{font-family:var(--dsw-alias-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px}',
      '.ci-plan-notes{margin:2px 0 0;padding-left:18px;color:var(--dsw-alias-label-secondary,#4e5969)}',
      '.ci-scope-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a919c)}',
    ].join('\n');

export const CSS_TAG_ID = 'dsh-agent-session-sync/panel.css';

/** Attach the panel stylesheet once per document. */
export function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-agent-session-sync';
  tag.dataset.pluginCss = CSS_TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
