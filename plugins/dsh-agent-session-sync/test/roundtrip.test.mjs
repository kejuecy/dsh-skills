/**
 * Round-trip tests: DSH → other agent → DSH must not lose or duplicate content.
 *
 * Every case here comes from a defect measured on real transcripts, so the
 * assertions encode the actual failure rather than a guess:
 *   - reasoning was folded into the answer and came back as plain text
 *   - truncation was re-applied on each hop with a different label
 *   - the import notice was prepended again on every hop
 *   - a catch-all tag regex deleted genuine user content (`<view>`, `<id>`)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSessionPlan } from '../lib/host/writer.js';
import { buildRows } from '../lib/host/sinks/workbuddy.js';

/** The WorkBuddy reader only resolves session files named like a UUID. */
const U1 = '33333333-3333-4333-8333-333333333333';
const U2 = '44444444-4444-4444-8444-444444444444';

/** A conversation with one prompt and one reply carrying both kinds of block. */
function sampleConversation(text = '这里是回答正文。', reasoning = '这里是思考过程。') {
  return {
    source: 'dsh',
    id: 'session-rt',
    title: '往返测试',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    cwd: 'C:\\proj',
    turns: [
      {
        at: 1_700_000_001_000,
        user: { content: [{ type: 'text', text: '用户的提问' }] },
        runs: [
          {
            at: 1_700_000_002_000,
            blocks: [
              { type: 'reasoning', text: reasoning },
              { type: 'text', text },
              { type: 'tool-call', id: 'call_x', name: 'bash', arguments: '{"command":"ls"}' },
            ],
            toolResults: [
              { callId: 'call_x', name: 'bash', arguments: '{"command":"ls"}', output: 'a.txt', isError: false, at: 1_700_000_003_000 },
            ],
          },
        ],
      },
    ],
    notes: [],
  };
}

test('reasoning is written as its own event, not folded into the answer', () => {
  // Regression: the sink used to merge reasoning into the assistant text with a
  // `【思考】` prefix. A one-way export still read fine, but importing it back
  // produced the thinking as ordinary text: the reasoning count dropped to zero
  // and the answer grew by exactly the reasoning length.
  const { rows } = buildRows(sampleConversation('回答正文', '思考内容'), { sessionId: '11111111-1111-4111-8111-111111111111' });
  const reasoning = rows.filter((row) => row.type === 'reasoning');
  const messages = rows.filter((row) => row.type === 'message' && row.role === 'assistant');

  assert.equal(reasoning.length, 1, 'one reasoning event expected');
  assert.equal(reasoning[0].rawContent[0].text, '思考内容', 'reasoning keeps its own text');
  assert.equal(reasoning[0].rawContent[0].type, 'reasoning_text', 'matches the real WorkBuddy shape');
  assert.deepEqual(reasoning[0].content, [], 'real transcripts leave content empty');

  assert.equal(messages.length, 1);
  const answer = messages[0].content.map((part) => part.text).join('');
  assert.equal(answer, '回答正文', 'the answer must not absorb the reasoning');
  assert.ok(!answer.includes('思考内容'), 'reasoning text must not appear in the answer');
});

test('reasoning and the answer share the run messageId', () => {
  // The reader groups a run by `providerData.messageId`; a missing or different
  // id splits one reply into several runs and inflates the tool count.
  const { rows } = buildRows(sampleConversation(), { sessionId: '22222222-2222-4222-8222-222222222222' });
  // Only the assistant reply shares one id; the user message is its own event.
  const relevant = rows.filter((row) =>
    row.type === 'reasoning' ||
    (row.type === 'message' && row.role === 'assistant') ||
    row.type === 'function_call' ||
    row.type === 'function_call_result');
  const ids = new Set(relevant.map((row) => row.providerData?.messageId));
  assert.equal(ids.size, 1, 'every event of one run must carry the same messageId');
  assert.equal([...ids][0] !== undefined, true);
});

test('the writer can suppress the notice entirely', () => {
  const plan = buildSessionPlan(sampleConversation(), { cwd: 'C:\\proj', mode: 'full', importNotice: false });
  const user = plan.events.find((event) => event.type === 'user/message');
  assert.equal(user.data.content.map((part) => part.text).join(''), '用户的提问');
});

test('user content that looks like markup is preserved', async () => {
  // Regression: `userText` used to end with `/<[a-z_][^>]*>/g`, which deletes
  // any lowercase tag. Real transcripts here contain WXML `<view>` (361),
  // `<text>` (144) and `<div>` (9), plus prose like `` `<id>.json` `` — all of
  // it was silently swallowed.
  const workbuddy = await import('../lib/host/providers/workbuddy.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-usertext-'));
  const projects = path.join(tmp, 'projects', 'c-proj');
  fs.mkdirSync(projects, { recursive: true });

  const content = '用 <view class="card"> 包起来，文件名按 `<id>.json`，参考 <div> 和 <text>\n';
  const events = [
    { type: 'session-meta', sessionId: U1, timestamp: 1_700_000_000_000, meta: {} },
    {
      type: 'message',
      role: 'user',
      timestamp: 1_700_000_001_000,
      sessionId: 'u1',
      cwd: 'C:\\proj',
      content: [{ type: 'input_text', text: content }],
    },
    {
      type: 'message',
      role: 'assistant',
      timestamp: 1_700_000_002_000,
      sessionId: 'u1',
      cwd: 'C:\\proj',
      content: [{ type: 'output_text', text: '收到' }],
      providerData: { messageId: 'm1' },
    },
  ];
  fs.writeFileSync(path.join(projects, `${U1}.jsonl`), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  fs.mkdirSync(path.join(tmp, 'workbuddy.db'), { recursive: true });

  const conversation = await workbuddy.load(U1, { ...process.env, WORKBUDDY_HOME: path.join(tmp, 'projects') });
  const prompt = conversation.turns[0].user.content.map((part) => part.text).join('');
  for (const fragment of ['<view class="card">', '`<id>.json`', '<div>', '<text>']) {
    assert.ok(prompt.includes(fragment), `must keep ${fragment}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('injected wrappers are still stripped from a user message', async () => {
  // The whitelist must keep doing its original job.
  const workbuddy = await import('../lib/host/providers/workbuddy.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-strip-'));
  const projects = path.join(tmp, 'projects', 'c-proj');
  fs.mkdirSync(projects, { recursive: true });

  const content = [
    '<system-reminder data-role="user-context">\nOS Version: win32\n</system-reminder>',
    '<current_time>\nThursday\n</current_time>',
    '真正的提问在这里',
  ].join('\n');
  const events = [
    { type: 'session-meta', sessionId: U2, timestamp: 1_700_000_000_000, meta: {} },
    {
      type: 'message', role: 'user', timestamp: 1_700_000_001_000, sessionId: 'u2', cwd: 'C:\\proj',
      content: [{ type: 'input_text', text: content }],
    },
  ];
  fs.writeFileSync(path.join(projects, `${U2}.jsonl`), events.map((e) => `${JSON.stringify(e)}\n`).join(''));

  const conversation = await workbuddy.load(U2, { ...process.env, WORKBUDDY_HOME: path.join(tmp, 'projects') });
  const prompt = conversation.turns[0].user.content.map((part) => part.text).join('');
  assert.equal(prompt, '真正的提问在这里', 'only the real prompt remains');
  fs.rmSync(tmp, { recursive: true, force: true });
});
