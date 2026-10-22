/**
 * Merge a re-import into the DSH session it already produced.
 *
 * Importing the same remote conversation twice used to *replace* the DSH
 * session: delete it, write a fresh transcript. That is wrong the moment the
 * user keeps working in DSH — the local continuation lives in the same log and
 * was thrown away with it.
 *
 * Merging instead treats the stored log as append-only history:
 *
 *   1. read the stored turns back through `dsh-source.js` (same neutral shape
 *      the providers produce, so both sides are directly comparable);
 *   2. find the longest common prefix of both turn lists — that is everything
 *      the previous import already wrote;
 *   3. append only the source turns past that prefix, numbered after the stored
 *      log's last turn and sequence number.
 *
 * Nothing is ever deleted, so a merge that finds nothing new is a no-op and a
 * merge that fails leaves the session exactly as it was.
 *
 * DSH requires the log to be contiguous from seq 0 with monotonically
 * increasing turn numbers (`assertContiguous` in the persistence seam refuses
 * anything else), which is why both counters are derived from the stored log
 * rather than restarted at zero.
 */
import { eventsToConversation } from './dsh-source.js';
import { buildSessionPlan, normalizeSessionId, stripImportNotice } from './writer.js';

/** Collapse whitespace so a re-wrapped prompt still compares equal. */
function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** The prompt text of one turn, with the import notice removed. */
function promptOf(turn) {
  const blocks = Array.isArray(turn?.user?.content) ? turn.user.content : [];
  const text = blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  return normalizeText(stripImportNotice(text));
}

/**
 * A comparable signature for one turn.
 *
 * Turns without a prompt are continuation rounds (a tool-only step DSH folded
 * into a turn of its own); their first assistant text is the best identity they
 * have.
 */
export function turnSignature(turn) {
  const prompt = promptOf(turn);
  if (prompt !== '') return prompt;
  for (const run of Array.isArray(turn?.runs) ? turn.runs : []) {
    for (const block of Array.isArray(run?.blocks) ? run.blocks : []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const text = normalizeText(block.text);
        if (text !== '') return text;
      }
    }
  }
  return '';
}

/**
 * Whether two turns are the same exchange.
 *
 * Beyond exact equality, the first turn is compared leniently: its text may
 * carry a provenance note this build did not write (an older plugin version, or
 * a note whose wording changes), and the source text is a suffix of the stored
 * text in that case.
 */
function sameTurn(left, right, { lenient = false } = {}) {
  const a = turnSignature(left);
  const b = turnSignature(right);
  if (a === b) return true;
  if (!lenient || a === '' || b === '') return false;
  return a.endsWith(b) || b.endsWith(a);
}

/**
 * How many leading turns the two lists agree on.
 * @param existing - turns read back from the DSH session.
 * @param incoming - turns of the conversation being imported.
 * @returns the length of the common prefix.
 */
export function commonPrefixLength(existing, incoming) {
  const limit = Math.min(existing.length, incoming.length);
  let matched = 0;
  while (matched < limit && sameTurn(existing[matched], incoming[matched])) matched += 1;
  if (matched !== 0 || limit === 0) return matched;
  if (!sameTurn(existing[0], incoming[0], { lenient: true })) return 0;
  matched = 1;
  while (matched < limit && sameTurn(existing[matched], incoming[matched])) matched += 1;
  return matched;
}

/**
 * Release a handle without letting a close failure propagate.
 *
 * Closing is bookkeeping (drain buffered events, release the write lease). A
 * merge that already read its log or already committed its batch must not be
 * reported as failed because of it: the caller's fallback for "merge failed" is
 * to write a second session, which is worse than a lingering lock the process
 * reclaims on exit.
 *
 * @param handle - the handle to close, if it has a `close`.
 */
async function closeQuietly(handle) {
  try {
    await handle?.close?.();
  } catch {
    // Intentionally ignored; see above.
  }
}

/** Highest turn number recorded in a stored log. */
function lastTurnNumber(events) {
  let max = 0;
  for (const event of events) {
    const turn = event?.data?.turn;
    if (typeof turn === 'number' && Number.isFinite(turn) && turn > max) max = turn;
  }
  return max;
}

/** Latest event timestamp in a stored log. */
function lastEventTime(events) {
  let max = 0;
  for (const event of events) {
    const time = event?.time;
    if (typeof time === 'number' && Number.isFinite(time) && time > max) max = time;
  }
  return max;
}

/**
 * Append whatever the source conversation gained since the last import.
 *
 * @param persistence - `ctx.sessionPersistence`.
 * @param conversation - the conversation being imported (as it is now).
 * @param options - writer options plus `sessionId` of the existing session.
 * @returns `{ merged, reason?, addedTurns?, overlap?, eventCount?, sessionId?, plan? }`.
 *   `merged: false` means "this cannot be merged; the caller decides what to do",
 *   with `reason`:
 *   - `no-session` — no usable id was supplied;
 *   - `unsupported` — the backend has no `open()` seam;
 *   - `missing` — the stored session is gone (the user deleted it);
 *   - `unreadable` — its log could not be decoded;
 *   - `empty` — it holds no turns to merge into;
 *   - `busy` — it is open elsewhere (a live session owns the only write handle);
 *   - `conflict` — the log changed between the read and the write, so the
 *     sequence numbers this merge computed are no longer valid.
 */
export async function mergeIntoSession(persistence, conversation, options = {}) {
  const sessionId = normalizeSessionId(options.sessionId);
  if (sessionId === undefined) return { merged: false, reason: 'no-session' };
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') {
    return { merged: false, reason: 'unsupported' };
  }

  let reader;
  try {
    reader = await persistence.open(sessionId, 'read');
  } catch {
    return { merged: false, reason: 'missing' };
  }

  // The header is needed to warm the projection cache later; a closed handle
  // may refuse to hand it out, so capture it while the handle is open.
  const header = reader?.header;
  let stored;
  try {
    stored = await reader.read();
  } catch {
    await closeQuietly(reader);
    return { merged: false, reason: 'unreadable' };
  }
  // A read handle holds no lease, but a close failure must not turn a
  // successful read into a failed import.
  await closeQuietly(reader);

  const events = Array.isArray(stored?.events) ? stored.events : [];
  const existing = eventsToConversation(events, { id: sessionId });
  if (existing === null || !Array.isArray(existing.turns) || existing.turns.length === 0) {
    return { merged: false, reason: 'empty' };
  }

  const incoming = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const overlap = commonPrefixLength(existing.turns, incoming);
  const added = incoming.slice(overlap);
  if (added.length === 0) {
    // Everything the source has is already stored — including, importantly,
    // anything the user wrote locally. Writing nothing is the correct merge.
    return { merged: true, addedTurns: 0, overlap, eventCount: 0, sessionId };
  }

  const plan = buildSessionPlan(
    { ...conversation, turns: added },
    {
      ...options,
      sessionId,
      // Contiguous continuation of the stored log.
      seqBase: events.length,
      turnBase: lastTurnNumber(events),
      continues: true,
      importNotice: false,
      minTime: lastEventTime(events) + 1,
    },
  );

  let writer;
  try {
    writer = await persistence.open(sessionId, 'write');
  } catch (error) {
    return {
      merged: false,
      reason: 'busy',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    await writer.append(plan.events);
    await writer.flush();
  } catch (error) {
    // The log moved between our read and our write — another process appended
    // to it, a torn tail needed repair, or the write lock was revoked. Nothing
    // was written (the backend appends the batch or nothing at all), but the
    // sequence numbers we computed are stale, and retrying blind could interleave
    // two writers. Report it so the caller chooses a safe fallback instead of
    // deleting a session someone else is actively writing.
    await closeQuietly(writer);
    return {
      merged: false,
      reason: 'conflict',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // The batch is durable at this point, so a close failure (a lock that could
  // not be released) must not be reported as a failed merge — that would send
  // the caller off to write a duplicate session beside a perfectly merged one.
  await closeQuietly(writer);

  return {
    merged: true,
    addedTurns: added.length,
    overlap,
    eventCount: plan.events.length,
    sessionId,
    // The full log, so the caller can warm the projection cache with a seed
    // that actually describes the session (not just the appended tail).
    plan: {
      header: header ?? { ...plan.header, id: sessionId },
      events: events.concat(plan.events),
    },
  };
}
