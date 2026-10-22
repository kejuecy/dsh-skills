/**
 * Keep a conversation inside the model context window it is being written into,
 * while losing as little of its substance as possible.
 *
 * A mature conversation can be larger than the model can ever read again: the
 * DSH agent reports `CONTEXT_WINDOW_EXCEEDED` when messages plus the requested
 * completion pass the ceiling (measured on this machine: 1 048 576 total, with
 * 256 000 reserved for the completion), and a third-party agent has its own
 * limit. Importing such a transcript faithfully produces a session that cannot
 * be resumed at all — the first prompt after the import fails.
 *
 * Compression happens here, before the transcript is written, and it never asks
 * a model to summarise anything: the plugin runs offline and a summarisation
 * call would cost the very context it is trying to save. The stage ladder is
 * ordered by what a *continuation* actually needs, so the cheap losses happen
 * first and the expensive ones only when nothing else fits:
 *
 *   1. **Trim** — clamp one oversized tool result / text block / argument, and
 *      drop reasoning blocks (the model does not need its old thinking back;
 *      they are usually the single largest thing in a transcript). Every turn
 *      survives, every conclusion survives.
 *   2. **Compact the middle** — for the old turns, keep the *thread* and drop
 *      the *noise*: tool output shrinks to a few hundred characters, long text
 *      to a paragraph, but each turn keeps its prompt and its answer. This is
 *      the stage that matters for fidelity: the conversation still reads like
 *      the conversation, just without the file dumps.
 *   3. **Elide the middle** — only when even that is too big: keep the opening
 *      turns and as much of the tail as fits, and replace everything between
 *      them with one synthetic user turn holding a per-turn digest
 *      (`第 k 轮 · 用户：… · 结论：…`, plus the tools that were used). A model
 *      reading it knows both what happened and that detail is missing — which is
 *      what keeps a resumed conversation from drifting.
 *   4. **Shrink** — last resort for one or two enormous turns: clamp what is
 *      left proportionally.
 *
 * Whatever is dropped stays in the source agent's own history, and the report
 * this module returns is what the panel shows the user, so nothing disappears
 * quietly.
 *
 * Sizes are estimated, not tokenized: the plugin may not have the model's
 * tokenizer, and the estimate only needs to be conservative enough to keep a
 * resumed session alive. See `estimateTokens` for the weights.
 */

/**
 * Context ceiling of the model a DSH agent runs, used when the caller does not
 * say otherwise. Matches the `max context length` the agent itself reports when
 * it refuses a request.
 */
export const DEFAULT_CONTEXT_LIMIT = 1_048_576;

/**
 * Room kept for the completion. The agent loop asks for this much output in one
 * round (measured from its own `CONTEXT_WINDOW_EXCEEDED` message), and that
 * budget counts against the same window as the messages do.
 */
export const DEFAULT_COMPLETION_RESERVE = 256_000;

/**
 * Share of the message budget a compressed transcript is allowed to use.
 *
 * The estimate below is a weight table, not a tokenizer, so landing exactly on
 * the ceiling would still overflow for text that tokenizes worse than assumed.
 * 85 % leaves enough slack for that while staying far away from the boundary.
 */
const SAFETY_RATIO = 0.85;

/**
 * Stage 1 ceilings. Generous on purpose: a tool result is clamped to 4 000
 * characters (roughly a page), which keeps the head and the tail of a build log
 * or a file dump — the parts that carry the command and the outcome — while
 * still removing the bulk. Raising these is safe; lowering them costs fidelity.
 */
const GENTLE = {
  /** One tool result. */
  toolResult: 4_000,
  /** One assistant or user text block. */
  text: 8_000,
  /** One tool-call argument JSON. */
  argument: 2_000,
  /** One user prompt — the thread itself, so almost never clamped. */
  prompt: 12_000,
};

/**
 * Stage 2 ceilings, applied only to the *old* middle turns. A prompt and an
 * answer stay readable; tool output shrinks to a stub that still says what the
 * tool did and how big the result was.
 */
const MIDDLE = {
  toolResult: 400,
  text: 1_200,
  argument: 300,
  prompt: 1_200,
};

/** Share of the budget the opening turns may keep when eliding. */
const HEAD_SHARE = 0.1;

/** Share of the budget the tail may keep when eliding. */
const TAIL_SHARE = 0.72;

/** Share of the budget the tail may keep from compaction (stage 2). */
const MIDDLE_TAIL_SHARE = 0.62;

/** Share of the budget the elision digest may spend (stage 3). */
const DIGEST_SHARE = 0.12;

/** Characters kept from one prompt inside a digest line. */
const DIGEST_PROMPT_CHARS = 140;

/** Characters kept from one answer inside a digest line. */
const DIGEST_ANSWER_CHARS = 170;

/** Maximum characters kept in an "arguments" stub left in a compacted turn. */
const STUB_CHARS = 80;

/** Marker shape used by `clampText`. */
const CLAMP_MARK = (dropped) => `\n…（中间已省略 ${dropped} 字符）…\n`;

/**
 * Split a string into a token estimate.
 *
 * DeepSeek-class tokenizers spend roughly one token per CJK character, about
 * 3.6 ASCII characters per token, and something in between for other scripts.
 * Counting per code point (not per UTF-16 unit) keeps surrogate pairs and emoji
 * from being double-counted.
 *
 * @param value - text to measure.
 * @returns estimated tokens (0 for anything that is not a string).
 */
export function estimateTokens(value) {
  if (typeof value !== 'string' || value === '') return 0;
  let wide = 0;
  let ascii = 0;
  let other = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x80) ascii += 1;
    else if (isWide(code)) wide += 1;
    else other += 1;
  }
  return wide + Math.ceil(ascii / 3.6) + Math.ceil(other * 0.6);
}

/**
 * Whether a code point belongs to a script that tokenizes near one token per
 * character (CJK ideographs, kana, Hangul, fullwidth forms).
 * @param code - code point.
 * @returns true for "wide" scripts.
 */
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303f) || // CJK radicals, punctuation
    (code >= 0x3040 && code <= 0x30ff) || // kana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
    (code >= 0xff00 && code <= 0xff60)    // fullwidth forms
  );
}

/** Token estimate of one content block. */
function blockTokens(block) {
  if (block === null || typeof block !== 'object') return 0;
  if (block.type === 'tool-call') return estimateTokens(block.arguments) + estimateTokens(block.name) + 8;
  return estimateTokens(block.text);
}

/** Token estimate of one turn, including its tool results. */
function turnTokens(turn) {
  let total = 0;
  for (const block of turn?.user?.content ?? []) total += blockTokens(block);
  for (const run of turn?.runs ?? []) {
    for (const block of run?.blocks ?? []) total += blockTokens(block);
    for (const result of run?.toolResults ?? []) {
      total += estimateTokens(result?.output) + estimateTokens(result?.arguments) + 8;
    }
  }
  return total;
}

/**
 * Estimated model-context size of a whole conversation.
 * @param conversation - neutral conversation.
 * @returns estimated tokens across every turn.
 */
export function conversationTokens(conversation) {
  let total = 0;
  for (const turn of conversation?.turns ?? []) total += turnTokens(turn);
  return total;
}

/**
 * The context budget a write has to fit into.
 *
 * Options win over the environment, which wins over the defaults, so the panel
 * can send a per-import override while a machine-wide `DSH_SESSION_CONTEXT_LIMIT`
 * still applies to hand-written API calls.
 *
 * @param options - `{ limit?, reserve? }`.
 * @param env - environment to read the overrides from.
 * @returns `{ limit, reserve, budget, target }` — `budget` is what the messages
 *   may use, `target` is the same budget after the safety margin.
 */
export function resolveBudget(options = {}, env = process.env) {
  const limit = positiveInt(options.limit)
    ?? positiveInt(env?.DSH_SESSION_CONTEXT_LIMIT)
    ?? DEFAULT_CONTEXT_LIMIT;
  const reserve = nonNegativeInt(options.reserve)
    ?? nonNegativeInt(env?.DSH_SESSION_COMPLETION_RESERVE)
    ?? DEFAULT_COMPLETION_RESERVE;
  // A reserve larger than the window would make any target meaningless; clamp
  // it to half the window instead of refusing to compress at all.
  const safeReserve = reserve >= limit ? Math.floor(limit / 2) : reserve;
  const budget = Math.max(1_000, limit - safeReserve);
  return { limit, reserve: safeReserve, budget, target: Math.max(1_000, Math.floor(budget * SAFETY_RATIO)) };
}

/** A positive integer option, or undefined. */
function positiveInt(value) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** A non-negative integer option, or undefined. */
function nonNegativeInt(value) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Deep clone plain conversation data (structuredClone when available). */
function clone(value) {
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Falls through: non-cloneable extras are dropped by JSON instead.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Cut a string down to `max` characters, keeping both ends.
 *
 * Both ends matter: the head names the file or the command, the tail carries
 * the error or the result. The marker states how much went missing so a model
 * reading the transcript does not treat the fragment as complete.
 *
 * @param text - source text.
 * @param max - characters to keep.
 * @returns the text, or its clamped form.
 */
function clampText(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  const marker = CLAMP_MARK(text.length - max);
  const keep = max - marker.length;
  if (keep <= 40) return text.slice(0, Math.max(0, max));
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ''}`;
}

/** Fresh counters for one compression run. */
function emptyCounts() {
  return { toolResults: 0, texts: 0, reasoning: 0, arguments: 0, prompts: 0, compactedTurns: 0 };
}

/**
 * Stage 1: clamp oversized blocks, drop reasoning, keep every turn.
 * @param turns - turns of the cloned conversation (mutated in place).
 * @param counts - counters to update.
 */
function trimBlocks(turns, counts) {
  for (const turn of turns) {
    for (const block of turn?.user?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > GENTLE.prompt) {
        block.text = clampText(block.text, GENTLE.prompt);
        counts.prompts += 1;
      }
    }
    for (const run of turn?.runs ?? []) {
      // Reasoning is the one thing a *reader* does not need back: it never
      // carries the answer, and it is usually the largest part of an assistant
      // turn. Dropping it is the cheapest real reduction available.
      const kept = [];
      for (const block of run.blocks ?? []) {
        if (block?.type === 'reasoning') {
          counts.reasoning += 1;
          continue;
        }
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > GENTLE.text) {
          block.text = clampText(block.text, GENTLE.text);
          counts.texts += 1;
        } else if (block?.type === 'tool-call' && typeof block.arguments === 'string' && block.arguments.length > GENTLE.argument) {
          block.arguments = clampText(block.arguments, GENTLE.argument);
          counts.arguments += 1;
        }
        kept.push(block);
      }
      run.blocks = kept;
      for (const result of run.toolResults ?? []) {
        if (typeof result.output === 'string' && result.output.length > GENTLE.toolResult) {
          result.output = clampText(result.output, GENTLE.toolResult);
          counts.toolResults += 1;
        }
        if (typeof result.arguments === 'string' && result.arguments.length > GENTLE.argument) {
          result.arguments = clampText(result.arguments, GENTLE.argument);
          counts.arguments += 1;
        }
      }
    }
  }
}

/**
 * Stage 2: keep the thread, drop the noise, on the old turns only.
 *
 * Prompts and answers stay (clamped to a paragraph), tool output becomes a stub
 * naming the size of what was cut. A reader — human or model — still sees what
 * each turn asked and concluded, which is what a continuation actually needs.
 *
 * @param turns - turns (mutated in place).
 * @param from - first turn of the middle region.
 * @param to - one past the last turn of the middle region.
 * @param counts - counters to update.
 * @returns how many turns were compacted.
 */
function compactRange(turns, from, to, counts) {
  let compacted = 0;
  for (let index = from; index < to; index += 1) {
    const turn = turns[index];
    if (turn === null || typeof turn !== 'object') continue;
    let touched = false;
    for (const block of turn.user?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > MIDDLE.prompt) {
        block.text = clampText(block.text, MIDDLE.prompt);
        counts.prompts += 1;
        touched = true;
      }
    }
    for (const run of turn.runs ?? []) {
      for (const block of run.blocks ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > MIDDLE.text) {
          block.text = clampText(block.text, MIDDLE.text);
          counts.texts += 1;
          touched = true;
        } else if (block?.type === 'tool-call' && typeof block.arguments === 'string' && block.arguments.length > MIDDLE.argument) {
          block.arguments = stubArguments(block.arguments);
          counts.arguments += 1;
          touched = true;
        }
      }
      for (const result of run.toolResults ?? []) {
        if (typeof result.output === 'string' && result.output.length > MIDDLE.toolResult) {
          result.output = clampText(result.output, MIDDLE.toolResult);
          counts.toolResults += 1;
          touched = true;
        }
        if (typeof result.arguments === 'string' && result.arguments.length > MIDDLE.argument) {
          result.arguments = stubArguments(result.arguments);
          counts.arguments += 1;
          touched = true;
        }
      }
    }
    if (touched) compacted += 1;
  }
  counts.compactedTurns += compacted;
  return compacted;
}

/**
 * A tool-argument stub: the beginning of the JSON, which is where the path or
 * the command lives, plus how much was cut.
 * @param text - argument JSON.
 * @returns the stub.
 */
function stubArguments(text) {
  const head = text.slice(0, STUB_CHARS).replaceAll(/\s+/g, ' ');
  return `${head}…（共 ${text.length} 字符）`;
}

/**
 * The turn ranges a compressed transcript keeps verbatim.
 *
 * The opening turns state what the conversation is for, the tail is what the
 * user was last doing — so both are kept by budget, from the front and from the
 * back, and everything between them is the middle.
 *
 * @param turns - turns of the conversation.
 * @param perTurn - token estimate per turn (index-aligned).
 * @param target - token budget for the result.
 * @param tailShare - share of the budget the tail may keep.
 * @returns `{ headEnd, tailStart }` — the middle is `[headEnd, tailStart)`.
 */
function keepBounds(turns, perTurn, target, tailShare) {
  const headBudget = Math.floor(target * HEAD_SHARE);
  let headEnd = 0;
  let headTokens = 0;
  while (headEnd < turns.length - 1 && headTokens + perTurn[headEnd] <= headBudget) {
    headTokens += perTurn[headEnd];
    headEnd += 1;
  }
  // The opening turn is always kept verbatim, even when it alone exceeds the
  // head share: without it the session has no statement of what the
  // conversation is about, and that is exactly what makes a continuation drift.
  if (headEnd === 0 && turns.length > 1) {
    headEnd = 1;
    headTokens = perTurn[0] ?? 0;
  }

  const tailBudget = Math.max(0, Math.floor(target * tailShare) - headTokens);
  let tailStart = turns.length;
  let tailTokens = 0;
  while (tailStart > headEnd && tailTokens + perTurn[tailStart - 1] <= tailBudget) {
    tailStart -= 1;
    tailTokens += perTurn[tailStart];
  }
  return { headEnd, tailStart };
}

/** One line of the elision digest: what was asked, what came of it. */
function digestLine(turn, number) {
  const prompt = firstText(turn?.user?.content).replaceAll(/\s+/g, ' ').trim();
  let answer = '';
  for (const run of turn?.runs ?? []) {
    const text = firstText(run?.blocks);
    if (text.trim() !== '') {
      answer = text.replaceAll(/\s+/g, ' ').trim();
      break;
    }
  }
  if (prompt === '' && answer === '') return '';
  const ask = prompt === '' ? '（延续上一轮的工具步骤）' : shorten(prompt, DIGEST_PROMPT_CHARS);
  const got = answer === '' ? '（这一轮没有文字结论）' : shorten(answer, DIGEST_ANSWER_CHARS);
  return `- 第 ${number} 轮 · 用户：${ask} · 结论：${got}`;
}

/** First non-empty text of a block list. */
function firstText(blocks) {
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') return block.text;
  }
  return '';
}

/** Shorten to `max` characters with an ellipsis. */
function shorten(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Tool names used inside the dropped range, for the digest footer. */
function toolsUsed(turns, limit = 12) {
  const names = [];
  for (const turn of turns) {
    for (const run of turn?.runs ?? []) {
      for (const block of run?.blocks ?? []) {
        if (block?.type !== 'tool-call') continue;
        const name = typeof block.name === 'string' ? block.name : '';
        if (name !== '' && !names.includes(name)) names.push(name);
        if (names.length >= limit) return names;
      }
    }
  }
  return names;
}

/**
 * The digest that stands in for an elided range.
 *
 * This is the whole point of the stage: a bare "some turns were removed" note
 * leaves the model free to invent what those turns said. A per-turn
 * ask → conclusion list keeps the narrative intact, so a continuation stays on
 * the rails even though the detail is gone.
 *
 * @param dropped - turns that are being removed.
 * @param from - 1-based number of the first dropped turn.
 * @param budget - token budget the digest may spend.
 * @returns `{ lines, omitted, tools }`.
 */
function buildDigest(dropped, from, budget) {
  const lines = [];
  let used = 0;
  for (let index = 0; index < dropped.length; index += 1) {
    const line = digestLine(dropped[index], from + index);
    if (line === '') continue;
    const cost = estimateTokens(line);
    if (used + cost > budget && lines.length > 0) return { lines, omitted: dropped.length - lines.length, tools: toolsUsed(dropped) };
    used += cost;
    lines.push(line);
  }
  return { lines, omitted: 0, tools: toolsUsed(dropped) };
}

/**
 * The turn that stands in for everything that was dropped.
 *
 * It is a normal user turn on purpose: DSH composes its own system prompt and
 * rewrites the protected system head on resume, so a note placed there would be
 * replaced. User-role context notes are how the harness itself injects context
 * and they survive every resume path.
 *
 * @param dropped - turns being removed.
 * @param from - 1-based number of the first dropped turn.
 * @param digest - `buildDigest()` result.
 * @returns a synthetic turn.
 */
function elisionTurn(dropped, from, digest) {
  const to = from + dropped.length - 1;
  const lines = [
    `【历史已压缩】第 ${from}–${to} 轮（共 ${dropped.length} 轮）因超出模型上下文上限被省略。`,
    '下面按轮保留「用户诉求 → 结论」的摘要，事实与数字以摘要为准；如果续聊需要这一段的具体细节，请让用户提供或重新导入，不要凭空推断。',
    ...digest.lines,
  ];
  if (digest.omitted > 0) lines.push(`- …… 另有 ${digest.omitted} 轮未列出`);
  if (digest.tools.length > 0) lines.push(`期间用到的工具：${digest.tools.join('、')}`);
  return {
    at: dropped[0]?.at,
    user: { content: [{ type: 'text', text: lines.join('\n') }] },
    runs: [],
  };
}

/**
 * Stage 3: drop the middle, replace it with a digest.
 * @param turns - compacted turns.
 * @param perTurn - token estimate per turn (index-aligned).
 * @param target - token budget for the result.
 * @returns `{ turns, dropped, from, to, digest }`.
 */
function elideMiddle(turns, perTurn, target) {
  if (turns.length <= 2) return { turns, dropped: 0, from: 0, to: 0, digest: null };
  const { headEnd, tailStart } = keepBounds(turns, perTurn, target, TAIL_SHARE);
  const dropped = turns.slice(headEnd, tailStart);
  if (dropped.length === 0) return { turns, dropped: 0, from: 0, to: 0, digest: null };
  if (tailStart === headEnd) return { turns, dropped: 0, from: 0, to: 0, digest: null };

  // The digest is capped so it can never eat the budget it is supposed to save.
  const head = turns.slice(0, headEnd);
  const tail = turns.slice(tailStart);
  const used = conversationTokens({ turns: head }) + conversationTokens({ turns: tail });
  const budget = Math.max(0, Math.min(Math.floor(target * DIGEST_SHARE), target - used));
  const digest = buildDigest(dropped, headEnd + 1, budget);
  return {
    turns: head.concat([elisionTurn(dropped, headEnd + 1, digest)], tail),
    dropped: dropped.length,
    from: headEnd + 1,
    to: tailStart,
    digest,
  };
}

/**
 * Stage 4: shrink what is left until it fits.
 *
 * Reached when the head and the tail alone are over budget — a single turn with
 * a pasted log, or a conversation of two enormous turns. Everything is clamped
 * proportionally rather than dropped, so the session keeps its shape.
 *
 * @param turns - turns to shrink in place.
 * @param target - token budget.
 * @returns the resulting estimate.
 */
function shrinkToFit(turns, target) {
  let current = conversationTokens({ turns });
  for (let round = 0; round < 6 && current > target; round += 1) {
    const ratio = Math.max(0.05, (target / current) * 0.95);
    for (const turn of turns) {
      for (const block of turn?.user?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') block.text = clampText(block.text, Math.max(240, Math.floor(block.text.length * ratio)));
      }
      for (const run of turn?.runs ?? []) {
        for (const block of run?.blocks ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') block.text = clampText(block.text, Math.max(240, Math.floor(block.text.length * ratio)));
          else if (block?.type === 'tool-call' && typeof block.arguments === 'string') block.arguments = clampText(block.arguments, Math.max(160, Math.floor(block.arguments.length * ratio)));
        }
        for (const result of run?.toolResults ?? []) {
          if (typeof result?.output === 'string') result.output = clampText(result.output, Math.max(160, Math.floor(result.output.length * ratio)));
        }
      }
    }
    current = conversationTokens({ turns });
  }
  return current;
}

/**
 * Compress one conversation so it fits the context window it is written into.
 *
 * `policy`:
 *  - `'auto'` (default) — compress only when the estimate exceeds the budget;
 *    the input object is returned untouched otherwise.
 *  - `'off'` — never compress.
 *
 * @param conversation - neutral conversation about to be written.
 * @param options - `{ policy?, limit?, reserve? }`.
 * @param env - environment for the budget overrides.
 * @returns `{ conversation, report }`; `conversation` is either the argument
 *   itself (nothing to do) or a compressed clone. `report`:
 *   `{ policy, limit, reserve, budget, target, before, after, compressed,
 *      reason, trimmed, compactedTurns, droppedTurns, droppedFrom, droppedTo,
 *      digestLines, keptTurns }`.
 */
export function compressConversation(conversation, options = {}, env = process.env) {
  const policy = options.policy === 'off' ? 'off' : 'auto';
  const budgetInfo = resolveBudget(options, env);
  const original = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const before = conversationTokens(conversation);
  const report = {
    policy,
    ...budgetInfo,
    before,
    after: before,
    compressed: false,
    reason: 'fits',
    trimmed: emptyCounts(),
    compactedTurns: 0,
    droppedTurns: 0,
    droppedFrom: 0,
    droppedTo: 0,
    digestLines: 0,
    keptTurns: original.length,
  };

  if (policy === 'off') return { conversation, report: { ...report, reason: 'off' } };
  if (before <= budgetInfo.target) return { conversation, report: { ...report, reason: 'fits' } };
  if (original.length === 0) return { conversation, report: { ...report, reason: 'empty' } };

  const working = clone(conversation);
  const turns = Array.isArray(working.turns) ? working.turns : [];
  const counts = emptyCounts();
  const target = budgetInfo.target;

  // 1. trim per block — keeps every turn.
  trimBlocks(turns, counts);
  let after = conversationTokens(working);
  let reason = 'trimmed';
  let dropped = 0;
  let from = 0;
  let to = 0;
  let digestLines = 0;

  // 2. compact the old turns — keeps every turn's ask and conclusion.
  if (after > target) {
    const bounds = keepBounds(turns, turns.map(turnTokens), target, MIDDLE_TAIL_SHARE);
    if (bounds.tailStart > bounds.headEnd) {
      compactRange(turns, bounds.headEnd, bounds.tailStart, counts);
      after = conversationTokens(working);
      reason = 'compacted';
    }
  }

  // 3. elide the middle with a digest — loses detail, keeps the narrative.
  if (after > target) {
    const elided = elideMiddle(turns, turns.map(turnTokens), target);
    if (elided.dropped > 0) {
      working.turns = elided.turns;
      dropped = elided.dropped;
      from = elided.from;
      to = elided.to;
      digestLines = elided.digest?.lines.length ?? 0;
      after = conversationTokens(working);
      reason = 'elided';
    }
  }

  // 4. proportional shrink — only for pathological shapes.
  if (after > target) after = shrinkToFit(working.turns, target);

  return {
    conversation: working,
    report: {
      ...report,
      after,
      compressed: true,
      reason,
      trimmed: counts,
      compactedTurns: counts.compactedTurns,
      droppedTurns: dropped,
      droppedFrom: from,
      droppedTo: to,
      digestLines,
      keptTurns: Array.isArray(working.turns) ? working.turns.length : 0,
    },
  };
}

/**
 * Human-readable size, as used by the panel.
 * @param tokens - token count.
 * @returns e.g. `786k`, `1.05M`.
 */
export function formatTokens(tokens) {
  const value = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/0$/, '')}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/**
 * One line describing what compression did, for a result row or a plan note.
 * @param report - `compressConversation().report`.
 * @returns the sentence, or '' when nothing was compressed.
 */
export function describeCompression(report) {
  if (report?.compressed !== true) return '';
  const parts = [];
  if (report.trimmed?.toolResults > 0) parts.push(`截断 ${report.trimmed.toolResults} 条工具输出`);
  if (report.trimmed?.reasoning > 0) parts.push(`去掉 ${report.trimmed.reasoning} 段思考过程`);
  if (report.trimmed?.texts > 0) parts.push(`截断 ${report.trimmed.texts} 段长文本`);
  if (report.trimmed?.arguments > 0) parts.push(`收窄 ${report.trimmed.arguments} 组工具参数`);
  if (report.compactedTurns > 0) parts.push(`精简中间 ${report.compactedTurns} 轮的工具细节（保留每轮诉求与结论）`);
  if (report.droppedTurns > 0) {
    const digest = report.digestLines > 0 ? `，已用 ${report.digestLines} 条「诉求→结论」摘要代替` : '';
    parts.push(`省略中间 ${report.droppedTurns} 轮（第 ${report.droppedFrom}–${report.droppedTo} 轮${digest}）`);
  }
  const detail = parts.length === 0 ? '' : `：${parts.join('、')}`;
  return (
    `历史约 ${formatTokens(report.before)} tokens，超出上下文上限（上限 ${formatTokens(report.limit)}，预留输出 ${formatTokens(report.reserve)}），` +
    `已压缩到约 ${formatTokens(report.after)} tokens${detail}`
  );
}
