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
 *     in-memory copy is flushed back over any disk write), import a new session
 *     and say why;
 *  3. otherwise merge: append only the turns the source gained. Nothing is
 *     deleted, so a local continuation written in DSH survives, and a merge
 *     that finds nothing new writes nothing at all;
 *  4. merging is impossible → fall back, and only then may the session be
 *     rewritten whole.
 *
 * The predecessor of this module did step 4 unconditionally: re-importing
 * deleted the DSH session and wrote a fresh transcript, which threw away every
 * turn the user had written locally since.
 */
import { mergeIntoSession } from './merge.js';
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
 * Write one conversation, merging into the session a previous import created.
 *
 * @param persistence - `ctx.sessionPersistence`.
 * @param conversation - normalized conversation to write.
 * @param options - `{ cwd, mode, sourceLabel, knownSessionId?, isOpen?, allowMerge? }`.
 * @returns `{ written, merged, addedTurns, warnings, reason }`; `written` is
 *   the `writeSession` / `mergeIntoSession` result the caller reports on, and
 *   `reason` names the branch that was taken (`created`, `open`, `busy`,
 *   `conflict`, `merged`, `replaced` or `rewritten`).
 */
export async function persistConversation(persistence, conversation, options = {}) {
  const base = { cwd: options.cwd, mode: options.mode, sourceLabel: options.sourceLabel };
  const knownSessionId = options.knownSessionId;
  const warnings = [];
  if (knownSessionId === undefined) {
    return {
      written: await writeSession(persistence, conversation, base),
      merged: false,
      addedTurns: null,
      warnings,
      reason: 'created',
    };
  }
  if (options.isOpen === true) {
    warnings.push('原会话正在打开：无法追加合并，已导入为新会话；关闭原会话后可手动删除旧的');
    return {
      written: await writeSession(persistence, conversation, base),
      merged: false,
      addedTurns: null,
      warnings,
      reason: 'open',
    };
  }
  if (options.allowMerge === false) {
    warnings.push('已覆盖原会话（按要求未合并）');
    return {
      written: await writeSession(persistence, conversation, { ...base, sessionId: knownSessionId, overwrite: true }),
      merged: false,
      addedTurns: null,
      warnings,
      reason: 'replaced',
    };
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
    return {
      written: await writeSession(persistence, conversation, base),
      merged: false,
      addedTurns: null,
      warnings,
      reason: outcome.reason,
    };
  }
  // Last resort: rewrite the session whole. Say which of the two possible
  // outcomes actually happened — claiming a rewrite while a duplicate sits
  // beside the original would be worse than saying nothing.
  const why = MERGE_REFUSAL[outcome.reason] ?? outcome.reason;
  const written = await writeSession(persistence, conversation, { ...base, sessionId: knownSessionId, overwrite: true });
  if (written.sessionId === knownSessionId) {
    warnings.push(`未能合并到原会话（${why}），已整份重写该会话`);
  } else {
    warnings.push(`未能合并到原会话（${why}），也无法覆盖原会话，已导入为新会话；原会话仍保留在列表里，可手动删除`);
  }
  return { written, merged: false, addedTurns: null, warnings, reason: 'rewritten' };
}
