/**
 * Export-direction tests: DSH session → neutral conversation → WorkBuddy.
 *
 * Everything runs inside a temporary fixture tree (fake `~/.dsh` and
 * `~/.workbuddy`), so the real user data is never touched. The fixture is
 * written with the same zstd framing / SQLite schema the real apps use, which
 * is what makes the round-trip assertion meaningful.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import { eventsToConversation, listDshConversations, loadDshConversation, readDshEvents } from '../lib/host/dsh-source.js';
import { atomicWrite } from '../lib/host/sinks/shared.js';
import * as workbuddySink from '../lib/host/sinks/workbuddy.js';
import { ExportService } from '../lib/host/export-service.js';

/** Create one temp fixture root with both agent homes inside. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-export-test-'));
  const dshHome = path.join(root, 'dsh');
  const wbHome = path.join(root, 'workbuddy');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(wbHome, 'projects'), { recursive: true });
  return { root, dshHome, wbHome, sessions: path.join(dshHome, 'sessions') };
}

/** Write one DSH session file as consecutive zstd frames (one event per frame). */
function writeDshSession(sessionsRoot, workspace, sessionId, events) {
  const dir = path.join(sessionsRoot, workspace, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const frames = events.map((event) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')));
  fs.writeFileSync(file, Buffer.concat(frames));
  return file;
}

/** A realistic DSH event log: two turns, tool call, reasoning, compaction. */
function sampleEvents(sessionId, cwd) {
  return [
    { type: 'session', version: 4, id: sessionId, createdAt: 1_700_000_000_000, cwd, isSeeded: false, delegationDepth: 0 },
    { type: 'turn/start', seq: 0, time: 1_700_000_001_000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1_700_000_001_000, data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: 1_700_000_001_000,
      data: {
        content: [{ type: 'text', text: '帮我看看这个仓库的测试覆盖率' }],
        source: { kind: 'user', clientTimeZone: 'Etc/GMT-8' },
        role: 'user',
        id: 'u1',
      },
      surfaceOp: 'append',
    },
    {
      type: 'session/title',
      seq: 3,
      time: 1_700_000_001_100,
      data: { title: '查看测试覆盖率', messageSeqs: [], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message',
      seq: 4,
      time: 1_700_000_002_000,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先去数一下测试文件' },
            { type: 'text', text: '我先统计一下测试文件数量。' },
            { type: 'tool-call', id: 'call_a', name: 'bash', arguments: '{"command":"ls test"}' },
          ],
          source: { kind: 'model' },
          id: 'a1',
        },
      },
    },
    { type: 'tool/call', seq: 5, time: 1_700_000_002_000, data: { turn: 1, step: 1, callId: 'call_a', name: 'bash', arguments: '{"command":"ls test"}' } },
    {
      type: 'tool/result',
      seq: 6,
      time: 1_700_000_002_100,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call_a' },
          toolCallId: 'call_a',
          content: [{ type: 'text', text: 'a.test.js\nb.test.js' }],
          id: 'r1',
        },
      },
    },
    { type: 'step/end', seq: 7, time: 1_700_000_002_200, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 8, time: 1_700_000_002_200, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 9, time: 1_700_000_003_000, data: { turn: 2 } },
    // A tool-replay user message must NOT become a real turn.
    {
      type: 'user/message',
      seq: 10,
      time: 1_700_000_003_000,
      data: { content: [{ type: 'text', text: 'TOOL REPLAY' }], source: { kind: 'tool' }, role: 'user', id: 'u2' },
    },
    { type: 'step/start', seq: 11, time: 1_700_000_003_000, data: { turn: 2, step: 1 } },
    {
      type: 'user/message',
      seq: 12,
      time: 1_700_000_003_000,
      data: {
        content: [{ type: 'text', text: '那就是两个测试文件？' }],
        source: { kind: 'user', clientTimeZone: 'Etc/GMT-8' },
        role: 'user',
        id: 'u3',
      },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      seq: 13,
      time: 1_700_000_004_000,
      data: {
        turn: 2,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '对，只有两个。' }], source: { kind: 'model' }, id: 'a2' },
      },
    },
    { type: 'step/end', seq: 14, time: 1_700_000_004_100, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: 15, time: 1_700_000_004_100, data: { turn: 2, reason: { kind: 'completed' } } },
    {
      type: 'compaction/summary',
      seq: 16,
      time: 1_700_000_005_000,
      data: { summary: [{ type: 'text', text: '用户问过测试覆盖率。' }] },
    },
  ];
}

/** Minimal WorkBuddy index with the columns the sink writes and reads. */
function createWorkbuddyDb(wbHome) {
  const dbPath = path.join(wbHome, 'workbuddy.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT,
      custom_title TEXT, status TEXT NOT NULL DEFAULT 'completed',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
      is_playground INTEGER NOT NULL DEFAULT 0, source_mode TEXT,
      is_background_automation INTEGER, model TEXT, expert_id TEXT, expert_locale TEXT,
      expert_runtime_identity TEXT, last_activity_at INTEGER, expert_marketplace TEXT,
      permission_mode TEXT, use_sandbox_cli INTEGER, project_id TEXT, mode TEXT,
      plugin_context_json TEXT, addon_selection TEXT, session_settings TEXT,
      last_user_prompt_expert_selection TEXT, context_window INTEGER, buddy_snapshot_id TEXT,
      buddy_binding_json TEXT, thought_level TEXT, transport TEXT NOT NULL DEFAULT 'local',
      conversation_origin TEXT, visibility TEXT, group_id TEXT, group_title TEXT,
      agent_dirty INTEGER, agent_dirty_at INTEGER, agent_last_synced INTEGER,
      verified_at INTEGER, unread INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL);
    INSERT INTO sessions (id, cwd, user_id, title, created_at, updated_at)
      VALUES ('existing-1', 'C:/proj', 'user-1', '原有会话', 1, 1);
    INSERT INTO workspaces (path, last_opened_at) VALUES ('C:/proj', 1);
  `);
  db.close();
  return dbPath;
}

/** Point both sinks and the source reader at the fixture. */
function withEnv(fx) {
  process.env.DSH_HOME = fx.dshHome;
  // `WORKBUDDY_HOME` names the projects root, matching the provider contract.
  process.env.WORKBUDDY_HOME = path.join(fx.wbHome, 'projects');
}

test('DSH event log converts to a neutral conversation', () => {
  const fx = fixture();
  const file = writeDshSession(fx.sessions, '--ws--', 'session-abc', sampleEvents('session-abc', 'C:\\proj'));
  const { events, truncated } = readDshEvents(file);
  assert.equal(truncated, 0);
  assert.equal(events.length, sampleEvents().length);

  const conversation = eventsToConversation(events, { id: 'session-abc' });
  assert.equal(conversation.title, '查看测试覆盖率');
  assert.equal(conversation.cwd, 'C:\\proj');
  // Turn 1 (prompt) + turn 2 (real prompt) + compaction summary.
  // The tool-source user message must be dropped.
  assert.equal(conversation.turns.length, 3);
  assert.equal(conversation.turns[0].runs.length, 1);
  assert.equal(conversation.turns[0].runs[0].blocks.length, 3);
  assert.equal(conversation.turns[0].runs[0].toolResults.length, 1);
  assert.equal(conversation.turns[0].runs[0].toolResults[0].output, 'a.test.js\nb.test.js');
  assert.ok(!conversation.turns.some((turn) => (turn.user?.content ?? []).some((b) => b.text === 'TOOL REPLAY')));
});

test('truncated tail frame is skipped, earlier frames survive', () => {
  const fx = fixture();
  const file = writeDshSession(fx.sessions, '--ws--', 'session-torn', sampleEvents('session-torn', 'C:\\proj'));
  // Append a half-written frame: valid magic, then a cut-off block header.
  fs.appendFileSync(file, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02]));
  const { events, truncated } = readDshEvents(file);
  assert.equal(truncated, 1);
  const conversation = eventsToConversation(events, { id: 'session-torn' });
  assert.ok(conversation.turns.length >= 2, 'earlier turns must still be readable');
});

test('missing tool result is repaired so every call stays paired', () => {
  const events = sampleEvents('session-x', 'C:\\proj').filter((event) => event.type !== 'tool/result');
  const conversation = eventsToConversation(events, { id: 'session-x' });
  const run = conversation.turns[0].runs[0];
  const call = run.blocks.find((block) => block.type === 'tool-call');
  const result = run.toolResults.find((entry) => entry.callId === call.id);
  assert.ok(result, 'a placeholder result must be added');
  assert.equal(result.isError, true);
  assert.ok((conversation.notes ?? []).some((note) => note.includes('配对')));
});

test('a result arriving after a later run is attached to the run that issued the call', () => {
  // Regression: DSH can emit `tool/result` while a *later* assistant run is
  // already open (parallel calls, sub-agent rounds). The reader used to push the
  // result into whatever run was current, then the repair pass saw an unpaired
  // result and synthesized a second `tool-call` block for it — inflating the
  // call count and splitting one call across two runs. Measured on a real
  // session: 191 calls in, 195 blocks out.
  const base = 1_700_000_000_000;
  const events = [
    { type: 'session', version: 4, id: 'session-late', createdAt: base, cwd: 'C:\\proj' },
    { type: 'turn/start', seq: 0, time: base + 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: base + 1, data: { content: [{ type: 'text', text: '跑一下' }], source: { kind: 'user' } } },
    // Run A issues two calls.
    {
      type: 'assistant/message',
      seq: 2,
      time: base + 2,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'call_a', name: 'bash', arguments: '{"command":"a"}' },
            { type: 'tool-call', id: 'call_b', name: 'bash', arguments: '{"command":"b"}' },
          ],
        },
      },
    },
    { type: 'tool/call', seq: 3, time: base + 3, data: { turn: 1, step: 1, callId: 'call_a', name: 'bash', arguments: '{"command":"a"}' } },
    { type: 'tool/call', seq: 4, time: base + 3, data: { turn: 1, step: 1, callId: 'call_b', name: 'bash', arguments: '{"command":"b"}' } },
    // Only the first result has arrived when run B opens.
    {
      type: 'tool/result',
      seq: 5,
      time: base + 4,
      data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_a', content: [{ type: 'text', text: 'A done' }] } },
    },
    {
      type: 'assistant/message',
      seq: 6,
      time: base + 5,
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '先看 A' }] } },
    },
    // The second result lands while run B is current.
    {
      type: 'tool/result',
      seq: 7,
      time: base + 6,
      data: { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'call_b', content: [{ type: 'text', text: 'B done' }] } },
    },
    { type: 'turn/end', seq: 8, time: base + 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ];

  const conversation = eventsToConversation(events, { id: 'session-late' });
  const runs = conversation.turns[0].runs;
  const blocks = runs.flatMap((run) => run.blocks).filter((block) => block.type === 'tool-call');
  const results = runs.flatMap((run) => run.toolResults);

  assert.equal(blocks.length, 2, 'the call count must match the transcript exactly');
  assert.deepEqual(blocks.map((block) => block.id).sort(), ['call_a', 'call_b']);
  assert.equal(results.length, 2, 'no placeholder result may be invented');

  // Both results must sit in run A — the run that issued the calls.
  const owner = runs.find((run) => run.blocks.some((block) => block.type === 'tool-call' && block.id === 'call_a'));
  assert.deepEqual(owner.toolResults.map((entry) => entry.callId).sort(), ['call_a', 'call_b']);
  assert.equal(owner.toolResults.find((entry) => entry.callId === 'call_b').output, 'B done');
});

test('listDshConversations reads the fixture tree', () => {
  const fx = fixture();
  withEnv(fx);
  writeDshSession(fx.sessions, '--a--', 'session-1', sampleEvents('session-1', 'C:\\proj'));
  writeDshSession(fx.sessions, '--b--', 'session-2', sampleEvents('session-2', 'C:\\other'));
  const rows = listDshConversations();
  assert.equal(rows.length, 2);
  const loaded = loadDshConversation('session-1');
  assert.equal(loaded.title, '查看测试覆盖率');
});

test('workbuddy sink: dry run writes nothing', async () => {
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  const file = writeDshSession(fx.sessions, '--ws--', 'session-dry', sampleEvents('session-dry', 'C:\\proj'));
  void file;
  const conversation = loadDshConversation('session-dry');

  const result = await workbuddySink.write(conversation, { dryRun: true, sessionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(result.dryRun, true);
  assert.equal(result.mode, 'created');
  assert.ok(result.rows > 0);
  assert.equal(fs.existsSync(result.target), false, 'dry run must not create the transcript');
});

test('workbuddy sink: writes transcript and index row, then overwrites with backup', async () => {
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  writeDshSession(fx.sessions, '--ws--', 'session-w', sampleEvents('session-w', 'C:\\proj'));
  const conversation = loadDshConversation('session-w');

  const first = await workbuddySink.write(conversation, {
    dryRun: false,
    sessionId: '22222222-2222-4222-8222-222222222222',
    force: true,
    cwd: 'C:\\proj',
  });
  assert.equal(first.ok, true);
  assert.equal(first.mode, 'created');
  assert.equal(fs.existsSync(first.target), true);

  // Transcript shape: one linked parentId chain, no dangling parents.
  const rows = fs
    .readFileSync(first.target, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  assert.equal(rows[0].type, 'session-meta');
  assert.equal(rows[1].type, 'ai-title');
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    if (row.parentId !== null) assert.ok(ids.has(row.parentId), `dangling parentId ${row.parentId}`);
  }
  const userRows = rows.filter((row) => row.type === 'message' && row.role === 'user');
  // Two real prompts plus the compaction summary (also user-role, by design).
  assert.equal(userRows.length, 3);
  assert.ok(!userRows.some((row) => row.content[0].text === 'TOOL REPLAY'));
  assert.ok(userRows.some((row) => row.content[0].text.startsWith('[上下文压缩摘要]')));
  assert.ok(userRows.some((row) => row.content[0].text === '帮我看看这个仓库的测试覆盖率'));
  const calls = rows.filter((row) => row.type === 'function_call');
  const results = rows.filter((row) => row.type === 'function_call_result');
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].callId, calls[0].callId);

  // Every event of one assistant reply must share one `messageId`: the read
  // side groups runs by it and would otherwise mint a run per event, inflating
  // the tool count on re-import. The sample has two runs, so exactly two ids.
  const assistantEvents = rows.filter((row) =>
    row.type === 'message' ? row.role === 'assistant' : row.type === 'function_call' || row.type === 'function_call_result',
  );
  const messageIds = new Set(assistantEvents.map((row) => row.providerData?.messageId));
  assert.equal(messageIds.size, 2, 'each run must carry exactly one messageId');
  assert.ok([...messageIds].every((value) => typeof value === 'string' && value !== ''), 'messageId must not be empty');
  // The tool call and its result belong to the same run they came from.
  assert.equal(calls[0].providerData.messageId, results[0].providerData.messageId);

  // Index: one row, visible (not deleted), correct title and cwd.
  const db = new DatabaseSync(path.join(fx.wbHome, 'workbuddy.db'));
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('22222222-2222-4222-8222-222222222222');
  assert.ok(row, 'session must be registered in the index');
  assert.equal(row.title, '查看测试覆盖率');
  assert.equal(row.cwd, 'C:\\proj');
  assert.equal(row.deleted_at, null);
  assert.equal(row.user_id, 'user-1', 'user id must follow the existing rows');
  assert.ok(db.prepare('SELECT * FROM sessions WHERE id = ?').get('existing-1'), 'existing sessions untouched');
  db.close();

  // Overwrite: same id, backup created, still one index row.
  const before = fs.readFileSync(first.target);
  const second = await workbuddySink.write(conversation, {
    dryRun: false,
    sessionId: '22222222-2222-4222-8222-222222222222',
    force: true,
    cwd: 'C:\\proj',
    title: '改过的标题',
  });
  assert.equal(second.mode, 'overwritten');
  assert.ok(second.backupPath, 'overwrite must back up the transcript');
  assert.ok(fs.readFileSync(second.backupPath).equals(before), 'backup must match the previous file');
  assert.ok(second.dbBackupPath && fs.existsSync(second.dbBackupPath), 'overwrite must back up the db');

  const db2 = new DatabaseSync(path.join(fx.wbHome, 'workbuddy.db'));
  const count = db2.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get('22222222-2222-4222-8222-222222222222').n;
  assert.equal(count, 1);
  assert.equal(db2.prepare('SELECT title FROM sessions WHERE id = ?').get('22222222-2222-4222-8222-222222222222').title, '改过的标题');
  db2.close();
});

test('workbuddy sink refuses to overwrite when overwrite is disabled', async () => {
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  writeDshSession(fx.sessions, '--ws--', 'session-o', sampleEvents('session-o', 'C:\\proj'));
  const conversation = loadDshConversation('session-o');

  await workbuddySink.write(conversation, { dryRun: false, sessionId: '33333333-3333-4333-8333-333333333333', force: true, cwd: 'C:\\proj' });
  await assert.rejects(
    () => workbuddySink.write(conversation, { dryRun: false, sessionId: '33333333-3333-4333-8333-333333333333', force: true, overwrite: false }),
    /已存在同名会话/,
  );
});

test('workbuddy sink: flat mode inlines tool calls as text', async () => {
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  writeDshSession(fx.sessions, '--ws--', 'session-f', sampleEvents('session-f', 'C:\\proj'));
  const conversation = loadDshConversation('session-f');

  const result = await workbuddySink.write(conversation, {
    dryRun: false,
    sessionId: '44444444-4444-4444-8444-444444444444',
    force: true,
    cwd: 'C:\\proj',
    flattenTools: true,
  });
  const rows = fs
    .readFileSync(result.target, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.type === 'function_call').length, 0);
  assert.ok(rows.some((row) => row.type === 'message' && row.role === 'assistant' && row.content[0].text.includes('[工具调用]')));
});

test('workbuddy sink gives imported sessions full access and keeps a user choice', async () => {
  // WorkBuddy resolves a session's permission level from `permission_mode`; a
  // row written without it lands on `default`, where every tool call waits for
  // an approval the imported transcript cannot answer.
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  writeDshSession(fx.sessions, '--ws--', 'session-perm', sampleEvents('session-perm', 'C:\\proj'));
  const conversation = loadDshConversation('session-perm');
  const sessionId = '77777777-7777-4777-8777-777777777777';
  const dbPath = path.join(fx.wbHome, 'workbuddy.db');

  await workbuddySink.write(conversation, { dryRun: false, sessionId, force: true, cwd: 'C:\\proj' });
  let db = new DatabaseSync(dbPath);
  assert.equal(
    db.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get(sessionId).permission_mode,
    'fullAccess',
  );
  // The user narrows it inside WorkBuddy; a re-export must not undo that.
  db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run('bypassPermissions', sessionId);
  db.close();

  await workbuddySink.write(conversation, { dryRun: false, sessionId, force: true, cwd: 'C:\\proj' });
  db = new DatabaseSync(dbPath);
  assert.equal(
    db.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get(sessionId).permission_mode,
    'bypassPermissions',
  );
  db.close();
});

test('workbuddy sink turns ask-user calls into text instead of a question card', () => {
  // WorkBuddy matches its native question tool by name, so a verbatim
  // `AskUserQuestion` call from DSH opens as a live-looking card with empty
  // arguments: nothing to answer, buttons that do nothing. The recorded Q&A in
  // the tool result is the portable form.
  const conversation = {
    id: 'session-ask',
    title: '带提问的会话',
    cwd: 'C:\\proj',
    createdAt: 1792634700000,
    turns: [
      {
        at: 1792634700000,
        user: { content: [{ type: 'text', text: '用哪种落地方式？' }] },
        runs: [
          {
            at: 1792634701000,
            blocks: [
              { type: 'text', text: '先确认两件事：' },
              { type: 'tool-call', id: 'call_ask_1', name: 'AskUserQuestion', arguments: '{}' },
            ],
            toolResults: [
              {
                callId: 'call_ask_1',
                output: '· 落地方式？ → 写入 WorkBuddy 原生会话（推荐）',
                isError: false,
                at: 1792634702000,
              },
            ],
          },
        ],
      },
    ],
  };

  const { rows, notes } = workbuddySink.buildRows(conversation, {
    sessionId: '55555555-5555-4555-8555-555555555555',
    cwd: 'C:\\proj',
  });

  assert.equal(rows.filter((row) => row.type === 'function_call').length, 0, 'no foreign question card may be written');
  assert.equal(rows.filter((row) => row.type === 'function_call_result').length, 0);
  const assistantText = rows
    .filter((row) => row.type === 'message' && row.role === 'assistant')
    .flatMap((row) => row.content.map((block) => block.text))
    .join('\n');
  assert.ok(assistantText.includes('先确认两件事'), 'the reply text must stay');
  assert.ok(assistantText.includes('写入 WorkBuddy 原生会话'), 'the recorded answer must survive as text');
  assert.ok(notes.some((note) => note.includes('向用户提问')), 'the conversion must be reported');
});

test('workbuddy sink rejects ids its own reader cannot see', async () => {
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  writeDshSession(fx.sessions, '--ws--', 'session-bad', sampleEvents('session-bad', 'C:\\proj'));
  const conversation = loadDshConversation('session-bad');
  // `providers/workbuddy.js` only finds `<uuid>` / `agent-<hash>` names, so a
  // friendly id would produce a file the UI never shows — refuse it up front.
  await assert.rejects(
    () => workbuddySink.write(conversation, { dryRun: true, sessionId: 'dryrun-target' }),
    /不符合 WorkBuddy 的命名规则/,
  );
  const plan = await workbuddySink.write(conversation, { dryRun: true });
  assert.match(plan.sessionId, /^[0-9a-f-]{36}$/, 'a generated id must be a UUID');
});

test('workbuddy sink requires a dry run before reporting overwrite mode', async () => {
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  writeDshSession(fx.sessions, '--ws--', 'session-p', sampleEvents('session-p', 'C:\\proj'));
  const conversation = loadDshConversation('session-p');
  await workbuddySink.write(conversation, { dryRun: false, sessionId: '55555555-5555-4555-8555-555555555555', force: true, cwd: 'C:\\proj' });
  const plan = await workbuddySink.write(conversation, { dryRun: true, sessionId: '55555555-5555-4555-8555-555555555555', cwd: 'C:\\proj' });
  assert.equal(plan.mode, 'overwritten');
  assert.equal(plan.exists, true);
});

test('workbuddy sink keeps the index inside an overridden home', () => {
  // Regression: `workbuddyHome()` used to be `dirname(projectsRoot())`, so an
  // override naming a projects root not literally called `projects` put the db
  // one level up — a temp fixture wrote `%TEMP%/workbuddy.db` and then read a
  // stale one created by an earlier run.
  const fx = fixture();
  // Point at an app home (contains projects/), the other accepted spelling.
  const env = { WORKBUDDY_HOME: fx.wbHome };
  assert.equal(workbuddySink.projectsRoot(env), path.join(fx.wbHome, 'projects'));
  assert.equal(workbuddySink.workbuddyHome(env), fx.wbHome);
  assert.equal(workbuddySink.databasePath(env), path.join(fx.wbHome, 'workbuddy.db'));

  // And when the override *is* the projects root.
  const env2 = { WORKBUDDY_HOME: path.join(fx.wbHome, 'projects') };
  assert.equal(workbuddySink.projectsRoot(env2), path.join(fx.wbHome, 'projects'));
  assert.equal(workbuddySink.workbuddyHome(env2), fx.wbHome);
  assert.equal(workbuddySink.databasePath(env2), path.join(fx.wbHome, 'workbuddy.db'));
});

test('workbuddy sink bootstraps a missing index instead of refusing', async () => {
  // A machine where WorkBuddy is installed but never ran has no db. The
  // transcript alone is invisible in the sidebar, so the sink must create the
  // minimal schema rather than fail with `no-index`.
  const fx = fixture();
  withEnv(fx);
  // Deliberately no createWorkbuddyDb(): the index does not exist yet.
  writeDshSession(fx.sessions, '--ws--', 'session-boot', sampleEvents('session-boot', 'C://proj'));
  const conversation = loadDshConversation('session-boot');

  const before = await workbuddySink.status(process.env);
  assert.equal(before.available, true, 'a writable tree with no db is still usable');

  const result = await workbuddySink.write(conversation, {
    dryRun: false,
    force: true,
    overwrite: true,
    sessionId: '77777777-7777-4777-8777-777777777777',
    cwd: 'C://proj',
  });
  assert.equal(result.dbBackupPath, null, 'a freshly created index has nothing to back up');

  // The created table must hold every column the sink inserts.
  const db = new DatabaseSync(path.join(fx.wbHome, 'workbuddy.db'));
  try {
    const row = db.prepare('SELECT id, title FROM sessions WHERE id = ?').get('77777777-7777-4777-8777-777777777777');
    assert.ok(row, 'the session row must exist');
    assert.equal(row.id, '77777777-7777-4777-8777-777777777777');
  } finally {
    db.close();
  }
});

test('export service accepts both nested and flat payload shapes', async () => {
  // The documented shape is `{ id, target, options }`; the panel sends flat
  // keys. Both must work — the flat form used to be rejected as "missing id".
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  writeDshSession(fx.sessions, '--ws--', 'session-shape', sampleEvents('session-shape', 'C://proj'));

  const calls = [];
  const service = new ExportService({
    logger: { info: (...args) => calls.push(args), warn: () => {}, error: () => {} },
  });

  const nested = await service.handle('export', {
    id: 'session-shape',
    target: 'workbuddy',
    options: { mode: 'full', confirm: false },
  });
  assert.equal(nested.ok, true, JSON.stringify(nested.error));
  assert.equal(nested.value.dryRun, true);

  const flat = await service.handle('export', {
    sourceId: 'session-shape',
    targetId: 'workbuddy',
    mode: 'full',
    confirm: false,
  });
  assert.equal(flat.ok, true, JSON.stringify(flat.error));
  assert.equal(flat.value.dryRun, true);

  // Neither shape may touch disk without confirm.
  assert.equal(fs.existsSync(path.join(fx.wbHome, 'projects')), true);
  const written = fs.readdirSync(path.join(fx.wbHome, 'projects'), { recursive: true })
    .filter((entry) => String(entry).endsWith('.jsonl'));
  assert.equal(written.length, 0, 'a plan must not create a transcript');
  service.dispose();
});

/** A service whose logger stays quiet during a test. */
function quietService() {
  return new ExportService({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
}

test('export sources list only the sessions the page shows', async () => {
  const fx = fixture();
  withEnv(fx);
  writeDshSession(fx.sessions, '--a--', 'session-keep', sampleEvents('session-keep', 'C://proj'));
  writeDshSession(fx.sessions, '--b--', 'session-hide', sampleEvents('session-hide', 'C://other'));

  const service = quietService();

  // No ids: a hand-written caller still sees the whole machine.
  const all = await service.handle('sources', {});
  assert.equal(all.ok, true, JSON.stringify(all.error));
  assert.equal(all.value.pageOnly, false);
  assert.equal(all.value.total, 2);
  assert.deepEqual(all.value.conversations.map((row) => row.id).sort(), ['session-hide', 'session-keep']);

  // With the page's ids, only that one session may be picked — the other one
  // exists on disk but the page does not show it.
  const scoped = await service.handle('sources', { ids: ['session-keep'] });
  assert.equal(scoped.ok, true, JSON.stringify(scoped.error));
  assert.equal(scoped.value.pageOnly, true);
  assert.equal(scoped.value.total, 2);
  assert.equal(scoped.value.hidden, 1);
  assert.deepEqual(scoped.value.conversations.map((row) => row.id), ['session-keep']);
  service.dispose();
});

test('export sources accept an id with or without the session- prefix', async () => {
  // Native DSH sessions live in a bare-UUID folder, sessions this plugin wrote
  // live in `session-<uuid>`, and the page may report either spelling.
  const fx = fixture();
  withEnv(fx);
  const id = '5f4c1d2e-0000-4000-8000-00000000abcd';
  writeDshSession(fx.sessions, '--ws--', id, sampleEvents(id, 'C://proj'));
  const service = quietService();

  const bare = await service.handle('sources', { ids: [id] });
  assert.equal(bare.value.conversations.length, 1);
  const prefixed = await service.handle('sources', { ids: [`session-${id}`] });
  assert.equal(prefixed.value.conversations.length, 1);
  service.dispose();
});

test('an empty page list yields an empty column, not the whole machine', async () => {
  const fx = fixture();
  withEnv(fx);
  writeDshSession(fx.sessions, '--ws--', 'session-only', sampleEvents('session-only', 'C://proj'));
  const service = quietService();

  const empty = await service.handle('sources', { ids: [] });
  assert.equal(empty.ok, true, JSON.stringify(empty.error));
  assert.equal(empty.value.pageOnly, true);
  assert.equal(empty.value.conversations.length, 0);
  assert.equal(empty.value.total, 1);
  service.dispose();
});

test('a delegated sub-agent session is never offered as an export source', async () => {
  // `[dsh-*:delegated …]` runs are subagents: the page has no row for them, so
  // the export list must not either — with or without the page's id list.
  const fx = fixture();
  withEnv(fx);
  const childEvents = sampleEvents('sub-1', 'C://proj').map((event) => event.type === 'session'
    ? { ...event, origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1 }
    : event);
  writeDshSession(fx.sessions, '--ws--', 'sub-1', childEvents);
  writeDshSession(fx.sessions, '--ws--', 'session-parent', sampleEvents('session-parent', 'C://proj'));
  const service = quietService();

  const all = await service.handle('sources', {});
  assert.deepEqual(all.value.conversations.map((row) => row.id), ['session-parent']);
  assert.equal(all.value.total, 2);
  assert.equal(all.value.hidden, 1);

  // Even if the page (or a hand-written caller) names the child explicitly.
  const named = await service.handle('sources', { ids: ['sub-1'] });
  assert.deepEqual(named.value.conversations.map((row) => row.id), []);
  service.dispose();
});

test('workbuddy sink derives a stable id from the DSH session id', async () => {
  // Exports used to mint a fresh UUID every time: the panel's "overwrite an
  // existing session" gate could never fire (a new id cannot collide) and
  // exporting twice left two sessions in WorkBuddy's sidebar. The DSH session
  // id is a UUID, so reusing it makes the second export an update.
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  writeDshSession(fx.sessions, '--ws--', `session-${uuid}`, sampleEvents(`session-${uuid}`, 'C://proj'));
  const conversation = loadDshConversation(`session-${uuid}`);

  const first = await workbuddySink.write(conversation, { dryRun: true });
  assert.equal(first.sessionId, uuid, 'the `session-` prefix is stripped, not kept as a filename');
  assert.equal(first.exists, false, 'nothing written yet');

  await workbuddySink.write(conversation, { dryRun: false, force: true, cwd: 'C://proj' });
  const second = await workbuddySink.write(conversation, { dryRun: true });
  assert.equal(second.sessionId, uuid, 'the id is derived the same way every time');
  assert.equal(second.exists, true, 'the second export targets the file the first one wrote');
  assert.equal(second.mode, 'overwritten');
});

test('workbuddy sink uses a native DSH uuid verbatim', async () => {
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  const uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  writeDshSession(fx.sessions, '--ws--', uuid, sampleEvents(uuid, 'C://proj'));
  const plan = await workbuddySink.write(loadDshConversation(uuid), { dryRun: true });
  assert.equal(plan.sessionId, uuid);
});

test('exporting the same session twice updates it in place', async () => {
  // The panel sends `overwrite: true` and `confirm: true` for every write, so
  // the service contract has to be an upsert: first export creates, the second
  // replaces the same file (with a backup) and the index keeps one row.
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  const uuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  writeDshSession(fx.sessions, '--ws--', `session-${uuid}`, sampleEvents(`session-${uuid}`, 'C://proj'));

  const service = quietService();
  // `force` only exists so the test can run while WorkBuddy is open on the
  // developer machine; the panel never sends it.
  const payload = { sourceId: `session-${uuid}`, targetId: 'workbuddy', mode: 'full', overwrite: true, force: true };

  const plan = await service.handle('export', { ...payload, confirm: false });
  assert.equal(plan.ok, true, JSON.stringify(plan.error));
  assert.equal(plan.value.exists, false);
  assert.equal(plan.value.sessionId, uuid);

  const first = await service.handle('export', { ...payload, confirm: true });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(first.value.mode, 'created');
  assert.equal(fs.existsSync(first.value.target), true);

  const second = await service.handle('export', { ...payload, confirm: true });
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.equal(second.value.mode, 'overwritten');
  assert.equal(second.value.target, first.value.target, 'same file, not a second copy');
  assert.ok(typeof second.value.backupPath === 'string' && second.value.backupPath !== '', 'the previous file is backed up');

  const db = new DatabaseSync(path.join(fx.wbHome, 'workbuddy.db'));
  try {
    const rows = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(uuid);
    assert.equal(rows.n, 1, 'one index row, not two');
  } finally {
    db.close();
  }
  service.dispose();
});

test('atomicWrite retries a Windows EPERM rename race and recovers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-retry-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, 'old content');
  let calls = 0;
  const eperm = () => {
    const error = new Error('EPERM: operation not permitted, rename');
    error.code = 'EPERM';
    return error;
  };
  const result = atomicWrite(file, 'new content', {
    replaceDeps: {
      rename: (from, to) => {
        calls += 1;
        if (calls <= 2) throw eperm(); // watcher/AV holds the destination
        fs.renameSync(from, to);
      },
      sleep: () => {},
    },
  });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new content');
  assert.equal(result.strategy, 'rename');
  assert.equal(result.retries, 2);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')).length, 0, 'no temp leftovers');
});

test('atomicWrite falls back to copy when the destination stays locked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-copy-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, 'old content');
  const eperm = () => {
    const error = new Error('EPERM: operation not permitted');
    error.code = 'EPERM';
    return error;
  };
  const result = atomicWrite(file, 'new content', {
    replaceDeps: {
      rename: () => {
        throw eperm(); // lock never clears
      },
      unlink: (target) => {
        if (target === file) throw eperm(); // cannot even drop the target
        fs.unlinkSync(target); // the temp file unlinks fine
      },
      sleep: () => {},
      attempts: 2,
    },
  });
  assert.equal(result.strategy, 'copy');
  assert.equal(result.recovered, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new content');
});

/** Record one import round trip in the durable map the exporter reads back. */
function writeImportedMap(dshHome, entries) {
  const dir = path.join(dshHome, 'session-import');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'imported.json'), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

test('exporting an imported session writes back to the original, not a copy', async () => {
  // Regression: import mints a fresh DSH uuid (`state.js`), and the exporter
  // derived the WorkBuddy id from *that* uuid. A conversation that made the
  // round trip therefore landed in WorkBuddy under a new id, leaving the
  // original session untouched beside it — two sessions, same title, same
  // project. The import map is the only record of the original id.
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  const originId = '99999999-9999-4999-8999-999999999999';
  writeDshSession(fx.sessions, '--ws--', 'session-round', sampleEvents('session-round', 'C://proj'));
  writeImportedMap(fx.dshHome, {
    [`workbuddy:${originId}`]: {
      source: 'workbuddy',
      remoteId: originId,
      sessionId: 'session-round',
      importedAt: 1_700_000_000_000,
      title: '查看测试覆盖率',
      cwd: 'C://proj',
      messageCount: 3,
      mode: 'full',
    },
  });
  const service = quietService();

  const plan = await service.handle('export', {
    id: 'session-round',
    target: 'workbuddy',
    options: { mode: 'full', confirm: false },
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.error));
  assert.equal(plan.value.sessionId, originId, 'the plan must target the original id');
  assert.ok(
    plan.value.notes.some((note) => note.includes('写回原会话')),
    'the plan must explain that it updates the original',
  );

  const done = await service.handle('export', {
    id: 'session-round',
    target: 'workbuddy',
    options: { mode: 'full', confirm: true, force: true },
  });
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.equal(done.value.sessionId, originId);
  const transcripts = fs
    .readdirSync(path.join(fx.wbHome, 'projects'), { recursive: true })
    .filter((entry) => String(entry).endsWith('.jsonl'))
    .map((entry) => path.basename(String(entry)));
  assert.deepEqual(transcripts, [`${originId}.jsonl`], 'exactly one transcript, under the original id');
  service.dispose();
});

test('a round-tripped session keeps the project folder that already holds it', async () => {
  // The DSH session may have been given a different cwd after import. Writing
  // the original id into a *second* project folder is the same duplicate bug by
  // another route, so the folder that already holds the id wins.
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  const originId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const originalDir = path.join(fx.wbHome, 'projects', 'c-old-project');
  fs.mkdirSync(originalDir, { recursive: true });
  fs.writeFileSync(path.join(originalDir, `${originId}.jsonl`), '{"type":"session-meta"}\n', 'utf8');
  writeDshSession(fx.sessions, '--ws--', 'session-moved', sampleEvents('session-moved', 'C://new-place'));
  const conversation = loadDshConversation('session-moved');

  const result = await workbuddySink.write(conversation, {
    dryRun: false,
    originId,
    force: true,
    cwd: 'C://new-place',
  });
  assert.equal(result.sessionId, originId);
  assert.equal(result.project, 'c-old-project', 'must stay in the folder that already holds the id');
  assert.equal(result.mode, 'overwritten');
  assert.equal(
    fs.existsSync(path.join(fx.wbHome, 'projects', 'c-new-place', `${originId}.jsonl`)),
    false,
    'no second copy under the new cwd',
  );
});

test('workbuddy sink ignores an origin id its own reader could not open', async () => {
  // A garbled map entry must not be able to break an export that works today.
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  writeDshSession(fx.sessions, '--ws--', 'session-bad-origin', sampleEvents('session-bad-origin', 'C://proj'));
  const conversation = loadDshConversation('session-bad-origin');

  const result = await workbuddySink.write(conversation, {
    dryRun: false,
    originId: 'not a session id',
    force: true,
    cwd: 'C://proj',
  });
  assert.match(result.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  assert.ok(!result.notes.some((note) => note.includes('写回原会话')), 'no round-trip note without an origin id');

  // An explicit id (the panel, a script) always outranks the origin.
  const explicit = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const forced = await workbuddySink.write(conversation, {
    dryRun: false,
    sessionId: explicit,
    originId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    force: true,
    cwd: 'C://proj',
  });
  assert.equal(forced.sessionId, explicit);
});

/** A DSH event log with `count` turns, each holding a 4 000-character tool result. */
function bulkyEvents(sessionId, cwd, count) {
  const events = [
    { type: 'session', version: 4, id: sessionId, createdAt: 1_700_000_000_000, cwd, isSeeded: false, delegationDepth: 0 },
  ];
  let seq = 0;
  let time = 1_700_000_001_000;
  for (let index = 1; index <= count; index += 1) {
    const callId = `call_${index}`;
    const args = '{"command":"cat big.log"}';
    events.push({ type: 'turn/start', seq: seq++, time, data: { turn: index } });
    events.push({ type: 'step/start', seq: seq++, time, data: { turn: index, step: 1 } });
    events.push({
      type: 'user/message',
      seq: seq++,
      time,
      data: { content: [{ type: 'text', text: `第 ${index} 轮：继续` }], source: { kind: 'user' }, role: 'user', id: `u${index}` },
      surfaceOp: 'append',
    });
    if (index === 1) {
      events.push({ type: 'session/title', seq: seq++, time, data: { title: '超长会话', messageSeqs: [], source: { kind: 'user' } } });
    }
    events.push({
      type: 'assistant/message',
      seq: seq++,
      time: time + 10,
      data: {
        turn: index,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `回答 ${index}` },
            { type: 'tool-call', id: callId, name: 'bash', arguments: args },
          ],
          source: { kind: 'model' },
          id: `a${index}`,
        },
      },
    });
    events.push({ type: 'tool/call', seq: seq++, time: time + 10, data: { turn: index, step: 1, callId, name: 'bash', arguments: args } });
    events.push({
      type: 'tool/result',
      seq: seq++,
      time: time + 20,
      data: {
        turn: index,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          content: [{ type: 'text', text: 'x'.repeat(4_000) }],
          id: `r${index}`,
        },
      },
    });
    events.push({ type: 'step/end', seq: seq++, time: time + 30, data: { turn: index, step: 1 } });
    events.push({ type: 'turn/end', seq: seq++, time: time + 30, data: { turn: index, reason: { kind: 'completed' } } });
    time += 1_000;
  }
  return events;
}

test('exporting a session over the context ceiling compresses it first', async () => {
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  writeDshSession(fx.sessions, '--ws--', 'session-big', bulkyEvents('session-big', 'C://proj', 30));

  const service = quietService();
  const limits = { contextLimit: 8_000, completionReserve: 1_000 };

  // The plan is built from the compressed conversation, so the preview already
  // reports the reduction instead of describing a write that would not fit.
  const plan = await service.handle('export', { id: 'session-big', target: 'workbuddy', mode: 'full', confirm: false, ...limits });
  assert.equal(plan.ok, true, JSON.stringify(plan.error));
  assert.equal(plan.value.compression.compressed, true);
  assert.ok(
    plan.value.notes.some((note) => /已压缩到约/.test(note)),
    `expected a compression note, got: ${plan.value.notes.join(' | ')}`,
  );

  const done = await service.handle('export', {
    id: 'session-big',
    target: 'workbuddy',
    mode: 'full',
    confirm: true,
    force: true,
    ...limits,
  });
  assert.equal(done.ok, true, JSON.stringify(done.error));
  const text = fs.readFileSync(done.value.target, 'utf8');
  assert.ok(text.includes('【历史已压缩】'), 'the written transcript must explain what was elided');
  assert.ok(text.length < 30 * 4_000, `written ${text.length} characters — expected a large reduction`);
  service.dispose();
});

test('turning compression off writes the transcript as it is', async () => {
  const fx = fixture();
  withEnv(fx);
  createWorkbuddyDb(fx.wbHome);
  writeDshSession(fx.sessions, '--ws--', 'session-raw', bulkyEvents('session-raw', 'C://proj', 10));

  const service = quietService();
  const done = await service.handle('export', {
    id: 'session-raw',
    target: 'workbuddy',
    mode: 'full',
    confirm: true,
    force: true,
    compress: 'off',
    contextLimit: 8_000,
    completionReserve: 1_000,
  });
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.equal(done.value.compression.compressed, false);
  const text = fs.readFileSync(done.value.target, 'utf8');
  assert.equal(text.includes('【历史已压缩】'), false);
  // Only clamped by the provider's own per-result ceiling, not by compression.
  assert.ok(text.length > 10 * 4_000 * 0.9, `written ${text.length} characters — expected the raw transcript`);
  service.dispose();
});
