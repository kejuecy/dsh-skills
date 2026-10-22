/**
 * Re-import policy: merge into the session the previous import created.
 *
 * Kept out of `service.js` because the decision itself is the interesting part
 * and has nothing to do with RPC dispatch, job bookkeeping or workspace
 * grouping — and because it is the one piece of the import pipeline where a
 * wrong branch deletes a transcript.
 *
 * The rules, in order:
 *
 *  1. no previous session → plain create;
 *  2. the previous session is open in the harness → never touch it (its
 *     in-memory copy is flushed back over any disk write), import beside it as a
 *     new session and say why — including that a source without a project
 *     directory can only appear under 「未分类」;
 *  3. otherwise merge: append only the turns the source gained. Nothing is
 *     deleted, so a local continuation written in DSH survives, and a merge
 *     that finds nothing new writes nothing at all;
 *  4. merging is impossible → fall back, and only then may the session be
 *     rewritten whole.
 *
 * The predecessor of this module did step 4 unconditionally: re-importing
 * deleted the DSH session and wrote a fresh transcript, which threw away every
 * turn the user had written locally since.
 *
 * Every *whole-session* write — a first import, the copy written beside an open
 * session, a forced rewrite — goes through `compress.js` first, so a transcript
 * that cannot fit the model's context window is compressed instead of being
 * imported in a form that fails on the first prompt after the import. Merging
 * is exempt: it appends only the turns the source gained, and rewriting history
 * that is already stored is not something an append can do safely.
 */
import { compressConversation, conversationTokens, describeCompression, formatTokens, resolveBudget } from './compress.js';
import { mergeIntoSession } from './merge.js';
import { sourceProjectDirectory } from './platform.js';
import { writeSession } from './writer.js';

/**
 * Why a merge was refused, in words the panel can show directly.
 *
 * A refusal is not an error: each one names a real, recoverable situation, and
 * the caller has a documented fallback for it.
 */
export const MERGE_REFUSAL = {
  'no-session': '没有可用的原会话 id',
  unsupported: '当前宿主的持久化后端不支持追加写入',
  missing: '原会话已不存在（可能已被删除）',
  unreadable: '原会话日志无法读取',
  empty: '原会话没有可接续的回合',
  conflict: '原会话在合并过程中被改动',
};

/**
 * Prepare a conversation for a whole-session write.
 *
 * Compression is applied here rather than in `service.js` because only this
 * module knows whether the write is a whole session or an append, and the two
 * need opposite treatment: a whole write may rewrite history (which is exactly
 * what compression does), an append must not.
 *
 * @param conversation - conversation about to be written whole.
 * @param options - `{ compress? }` — see `compress.js`.
 * @param warnings - result-row notes, extended in place.
 * @returns `{ conversation, report }`.
 */
function prepareWrite(conversation, options, warnings) {
  const { conversation: prepared, report } = compressConversation(conversation, options.compress ?? {});
  const note = describeCompression(report);
  if (note !== '') warnings.push(note);
  return { conversation: prepared, report };
}

/**
 * Write one conversation, merging into the session a previous import created.
 *
 * @param persistence - `ctx.sessionPersistence`.
 * @param conversation - normalized conversation to write.
 * @param options - `{ cwd, mode, sourceLabel, compress?, knownSessionId?, knownCompressed?, isOpen?, allowMerge? }`.
 * @returns `{ written, merged, addedTurns, warnings, reason, compression?, skipped? }`;
 *   `written` is the `writeSession` / `mergeIntoSession` result the caller
 *   reports on (`null` when nothing was written on purpose), `skipped` marks
 *   that case, `compression` is the `compress.js` report of a whole-session
 *   write, and `reason` names the branch that was taken (`created`, `open`,
 *   `busy`, `conflict`, `merged`, `replaced` or `rewritten`).
 */
export async function persistConversation(persistence, conversation, options = {}) {
  const base = { cwd: options.cwd, mode: options.mode, sourceLabel: options.sourceLabel };
  const knownSessionId = options.knownSessionId;
  const warnings = [];
  if (knownSessionId === undefined) {
    const prepared = prepareWrite(conversation, options, warnings);
    return {
      written: await writeSession(persistence, prepared.conversation, base),
      merged: false,
      addedTurns: null,
      warnings,
      compression: prepared.report,
      reason: 'created',
    };
  }
  if (options.isOpen === true) {
    // A live session keeps its own copy of the transcript and flushes it back on
    // the next write, so appending to the stored log would be silently undone
    // (and could corrupt the open conversation). The import therefore lands
    // beside it as a *new* session — nothing the source gained is lost — and the
    // result row spells out the two consequences the user would otherwise have
    // to reverse-engineer: the original was untouched (so they now have two),
    // and a source without a project directory can only be grouped as 「未分类」.
    warnings.push('原会话正在 DSH 里打开：无法合并，已导入为新会话（原会话未改动）；关掉原会话后可手动删掉多余的那条');
    if (sourceProjectDirectory(conversation.cwd) === undefined) {
      warnings.push('来源会话的 cwd 是用户主目录或已不存在（没有项目目录），这条新会话在侧边栏会显示在「未分类」');
    }
    const prepared = prepareWrite(conversation, options, warnings);
    return {
      written: await writeSession(persistence, prepared.conversation, base),
      merged: false,
      addedTurns: null,
      warnings,
      compression: prepared.report,
      reason: 'open',
    };
  }
  // A session that was itself written compressed can never be merged: its stored
  // turns are a rewrite of the source (trimmed blocks, an elided middle), so the
  // common-prefix comparison finds nothing and an append would copy the whole
  // conversation in again. Rewriting it whole — compressed again — is the only
  // correct outcome, and the row says so.
  if (options.allowMerge === false || options.knownCompressed === true) {
    const forced = options.allowMerge === false;
    warnings.push(
      forced
        ? '已覆盖原会话（按要求未合并）'
        : '该会话上次是「压缩导入」的（历史已被改写），无法增量比对，本次整份重写为最新的压缩版本；如果你在 DSH 里对这条会话续聊过，那些回合会丢失',
    );
    const prepared = prepareWrite(conversation, options, warnings);
    return {
      written: await writeSession(persistence, prepared.conversation, { ...base, sessionId: knownSessionId, overwrite: true }),
      merged: false,
      addedTurns: null,
      warnings,
      compression: prepared.report,
      reason: 'replaced',
    };
  }

  // Appending cannot shrink what is already stored, so a conversation that is
  // still over the ceiling has to be reported rather than silently merged.
  const budget = resolveBudget(options.compress ?? {});
  const tokens = conversationTokens(conversation);
  if (tokens > budget.target) {
    warnings.push(
      `这条会话的历史约 ${formatTokens(tokens)} tokens，已超出模型上下文上限（${formatTokens(budget.budget)}）；` +
        '本次是增量合并，不会压缩已有历史，在 DSH 里续聊时可能报上下文超限',
    );
  }

  const outcome = await mergeIntoSession(persistence, conversation, { ...base, sessionId: knownSessionId });
  if (outcome.merged === true) {
    return {
      written: {
        sessionId: outcome.sessionId,
        eventCount: outcome.eventCount,
        plan: outcome.plan,
        replaced: false,
        removedVia: null,
      },
      merged: true,
      addedTurns: outcome.addedTurns,
      warnings,
      reason: 'merged',
    };
  }
  if (outcome.reason === 'busy' || outcome.reason === 'conflict') {
    // `busy`: ownership was taken between the liveness check and the open.
    // `conflict`: the log moved between our read and our write.
    // Both mean somebody else is writing this session right now — never delete
    // underneath them, import beside it instead.
    warnings.push(
      outcome.reason === 'busy'
        ? '原会话正在被占用：已导入为新会话；关闭原会话后可手动删除旧的'
        : '原会话在合并过程中被改动：已导入为新会话，未写入原会话；确认无误后可手动删除多的那个',
    );
    const prepared = prepareWrite(conversation, options, warnings);
    return {
      written: await writeSession(persistence, prepared.conversation, base),
      merged: false,
      addedTurns: null,
      warnings,
      compression: prepared.report,
      reason: outcome.reason,
    };
  }
  // Last resort: rewrite the session whole. Say which of the two possible
  // outcomes actually happened — claiming a rewrite while a duplicate sits
  // beside the original would be worse than saying nothing.
  const why = MERGE_REFUSAL[outcome.reason] ?? outcome.reason;
  const prepared = prepareWrite(conversation, options, warnings);
  const written = await writeSession(persistence, prepared.conversation, { ...base, sessionId: knownSessionId, overwrite: true });
  if (written.sessionId === knownSessionId) {
    warnings.push(`未能合并到原会话（${why}），已整份重写该会话`);
  } else {
    warnings.push(`未能合并到原会话（${why}），也无法覆盖原会话，已导入为新会话；原会话仍保留在列表里，可手动删除`);
  }
  return { written, merged: false, addedTurns: null, warnings, compression: prepared.report, reason: 'rewritten' };
}
