/**
 * Context-window compression: the pass that keeps an imported or exported
 * conversation inside the model window before it is written.
 *
 * The limits here are deliberately tiny (a few thousand tokens) so the tests
 * exercise real elision with small fixtures, instead of allocating megabytes to
 * reach the real 1M-token ceiling.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_COMPLETION_RESERVE,
  DEFAULT_CONTEXT_LIMIT,
  compressConversation,
  conversationTokens,
  describeCompression,
  estimateTokens,
  formatTokens,
  resolveBudget,
} from '../lib/host/compress.js';

/** One turn: a prompt, an answer, an optional tool result and reasoning. */
function turn(index, options = {}) {
  const output = options.output ?? '';
  const reasoning = options.reasoning ?? '';
  const blocks = [];
  if (reasoning !== '') blocks.push({ type: 'reasoning', text: reasoning });
  blocks.push({ type: 'text', text: options.answer ?? `回答 ${index}` });
  if (output !== '') blocks.push({ type: 'tool-call', id: `call-${index}`, name: 'read_file', arguments: '{"path":"a.txt"}' });
  const toolResults = output === '' ? [] : [{ callId: `call-${index}`, name: 'read_file', arguments: '{"path":"a.txt"}', output }];
  return {
    at: 1_700_000_000_000 + index * 1_000,
    user: { content: [{ type: 'text', text: options.prompt ?? `第 ${index} 个问题` }] },
    runs: [{ at: 1_700_000_000_500 + index * 1_000, blocks, toolResults }],
  };
}

/** A conversation of `count` uniform turns. */
function conversation(count, options = {}) {
  return {
    source: 'codex',
    id: 'remote-1',
    title: '超长历史',
    cwd: 'C:\\proj',
    turns: Array.from({ length: count }, (_, index) => turn(index + 1, options)),
  };
}

test('estimateTokens charges about one token per CJK character', () => {
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(undefined), 0);
  // 36 ASCII characters at 3.6 characters per token.
  assert.equal(estimateTokens('a'.repeat(36)), 10);
});

test('conversationTokens counts prompts, answers and tool results', () => {
  const tokens = conversationTokens(conversation(2, { output: 'x'.repeat(360) }));
  assert.ok(tokens > 200, `expected a few hundred tokens, got ${tokens}`);
  assert.equal(conversationTokens({ turns: [] }), 0);
});

test('a conversation inside the budget is returned untouched', () => {
  const input = conversation(2);
  const result = compressConversation(input, { limit: 100_000, reserve: 1_000 });
  assert.equal(result.conversation, input, 'the same object must come back, not a copy');
  assert.equal(result.report.compressed, false);
  assert.equal(result.report.reason, 'fits');
});

test('policy off never compresses, even far over the ceiling', () => {
  const input = conversation(60, { output: 'y'.repeat(2_000) });
  const result = compressConversation(input, { policy: 'off', limit: 4_000, reserve: 1_000 });
  assert.equal(result.conversation, input);
  assert.equal(result.report.compressed, false);
  assert.equal(result.report.reason, 'off');
});

test('the first pass trims tool output and drops reasoning without losing a turn', () => {
  const input = conversation(3, { output: 'z'.repeat(20_000), reasoning: '思考'.repeat(1_500) });
  const result = compressConversation(input, { limit: 6_000, reserve: 1_000 });

  assert.equal(result.report.compressed, true);
  assert.equal(result.report.reason, 'trimmed');
  assert.equal(result.report.droppedTurns, 0);
  assert.equal(result.report.keptTurns, 3, 'every turn must survive a trim-only pass');
  assert.equal(result.report.trimmed.toolResults, 3);
  assert.equal(result.report.trimmed.reasoning, 3);

  for (const stored of result.conversation.turns) {
    for (const run of stored.runs) {
      assert.equal(run.blocks.some((block) => block.type === 'reasoning'), false, 'reasoning must be dropped');
      for (const block of run.blocks) {
        if (block.type === 'text') assert.ok(block.text.length <= 6_000);
      }
      for (const item of run.toolResults) assert.ok(item.output.length <= 4_100, `tool output ${item.output.length} too long`);
    }
  }
  assert.ok(result.report.after < result.report.before);
});

test('the middle is elided when trimming cannot get under the ceiling', () => {
  const input = conversation(40, { output: 'w'.repeat(3_000) });
  const result = compressConversation(input, { limit: 4_000, reserve: 1_000 });
  const { report } = result;

  assert.equal(report.compressed, true);
  assert.equal(report.reason, 'elided');
  assert.ok(report.droppedTurns > 10, `expected a big elision, dropped ${report.droppedTurns}`);
  assert.ok(report.droppedFrom >= 2, 'the opening turn is never dropped');

  const turns = result.conversation.turns;
  // Opening turn kept verbatim, newest turn kept, one notice in between.
  assert.equal(turns[0].user.content[0].text, '第 1 个问题');
  assert.equal(turns.at(-1).user.content[0].text, '第 40 个问题');
  const notice = turns[1].user.content[0].text;
  assert.match(notice, /【历史已压缩】/);
  assert.match(notice, new RegExp(`第 ${report.droppedFrom}–${report.droppedTo} 轮`));
  assert.match(notice, /第 2 个问题/, 'the notice lists what was dropped');
  assert.match(notice, /用户：/, 'each dropped turn is listed as ask → conclusion');
  assert.match(notice, /结论：/, 'the conclusion of a dropped turn survives');
  assert.match(notice, /回答 2/, 'the digest keeps the answer of that turn');
  assert.match(notice, /期间用到的工具：read_file/);
  assert.match(notice, /不要凭空推断/);
  assert.ok(report.digestLines > 0, 'the digest must be reported');

  assert.equal(turns.length, report.keptTurns);
  assert.ok(report.after <= report.target, `after ${report.after} should fit target ${report.target}`);
});

test('stage 2 keeps every ask and every conclusion, and only shrinks the tool noise', () => {
  // This is the fidelity guarantee that matters for a continuation: a session
  // that has to be compressed should still read like the same conversation.
  // Stage 2 may shorten tool output, but it must not remove a turn, a prompt or
  // an answer.
  const input = conversation(12, { output: 'x'.repeat(3_000) });
  const result = compressConversation(input, { limit: 12_000, reserve: 2_000 });
  const { report } = result;

  assert.equal(report.compressed, true);
  assert.equal(report.reason, 'compacted');
  assert.equal(report.droppedTurns, 0, 'this stage drops no turn at all');
  assert.equal(report.keptTurns, 12);
  assert.ok(report.compactedTurns > 0, 'the old turns were compacted');
  assert.ok(report.after < report.before);

  const turns = result.conversation.turns;
  for (const [index, stored] of turns.entries()) {
    const prompt = stored.user.content[0].text;
    assert.equal(prompt, `第 ${index + 1} 个问题`, 'every prompt survives verbatim');
    const blocks = stored.runs.flatMap((run) => run.blocks);
    const answer = blocks.find((block) => block.type === 'text');
    assert.ok(answer !== undefined && answer.text !== '', 'every answer survives');
  }
  const outputs = turns
    .flatMap((stored) => stored.runs.flatMap((run) => run.toolResults))
    .map((item) => item.output.length);
  assert.ok(outputs.some((length) => length <= 500), 'the compacted middle keeps a stub, not the dump');
});

test('a single enormous turn is clamped instead of dropped', () => {
  const input = {
    ...conversation(1),
    turns: [{ at: 1, user: { content: [{ type: 'text', text: '长'.repeat(40_000) }] }, runs: [] }],
  };
  const result = compressConversation(input, { limit: 6_000, reserve: 1_000 });
  assert.equal(result.report.compressed, true);
  assert.equal(result.conversation.turns.length, 1, 'the only turn must stay');
  assert.ok(result.report.after <= result.report.target, `after ${result.report.after} vs target ${result.report.target}`);
});

test('resolveBudget honours environment overrides and clamps a silly reserve', () => {
  const defaults = resolveBudget({}, {});
  assert.equal(defaults.limit, DEFAULT_CONTEXT_LIMIT);
  assert.equal(defaults.reserve, DEFAULT_COMPLETION_RESERVE);
  assert.equal(defaults.budget, DEFAULT_CONTEXT_LIMIT - DEFAULT_COMPLETION_RESERVE);
  assert.ok(defaults.target < defaults.budget, 'the safety margin must stay inside the budget');

  const overridden = resolveBudget({}, { DSH_SESSION_CONTEXT_LIMIT: '100000' });
  assert.equal(overridden.limit, 100_000);
  // The default 256k reserve cannot fit a 100k window, so it is halved.
  assert.equal(overridden.reserve, 50_000);
  assert.equal(overridden.budget, 50_000);

  const explicit = resolveBudget({ limit: 8_000, reserve: 1_000 }, { DSH_SESSION_CONTEXT_LIMIT: '100000' });
  assert.equal(explicit.limit, 8_000, 'options must beat the environment');
  assert.equal(explicit.budget, 7_000);
});

test('formatTokens and describeCompression read like the panel copy', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(786_500), '787k');
  assert.equal(formatTokens(1_048_576), '1.05M');
  assert.equal(describeCompression({ compressed: false }), '');

  const line = describeCompression({
    compressed: true,
    before: 1_120_000,
    after: 660_000,
    limit: 1_048_576,
    reserve: 256_000,
    trimmed: { toolResults: 12, reasoning: 30, texts: 2, arguments: 0 },
    compactedTurns: 8,
    droppedTurns: 37,
    digestLines: 31,
    droppedFrom: 3,
    droppedTo: 39,
  });
  assert.match(line, /1\.12M tokens/);
  assert.match(line, /上限 1\.05M/);
  assert.match(line, /预留输出 256k/);
  assert.match(line, /已压缩到约 660k tokens/);
  assert.match(line, /截断 12 条工具输出/);
  assert.match(line, /精简中间 8 轮的工具细节/);
  assert.match(line, /省略中间 37 轮（第 3–39 轮，已用 31 条「诉求→结论」摘要代替）/);
});
