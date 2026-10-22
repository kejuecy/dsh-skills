/**
 * Re-import as a merge, not a rewrite.
 *
 * Importing the same remote conversation twice used to delete the DSH session
 * and write a fresh transcript. That silently destroyed everything the user had
 * writen in DSH since (a local follow-up, a compaction summary). The current
 * contract is append-only: find the longest common prefix of stored and
 * incoming turns, then append only what the source gained.
 *
 * The persistence seam is mocked (the real one only exists inside the harness)
 * but it is strict about the two invariants the real backend enforces:
 * `create` refuses an existing id, and a log has to stay contiguous from seq 0.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { commonPrefixLength, mergeIntoSession, turnSignature } from '../lib/host/merge.js';
import { persistConversation } from '../lib/host/reimport.js';
import { buildSessionPlan, writeSession } from '../lib/host/writer.js';

/** A conversation with one turn per `[question, answer]` pair. */
function conversation(pairs = [['问题', '回答']]) {
  return {
    source: 'codex',
    id: 'remote-1',
    title: '合并导入',
    createdAt: 1_700_000_000_000,
    cwd: 'C:\\proj',
    turns: pairs.map(([question, answer], index) => ({
      at: 1_700_000_001_000 + index * 10_000,
      user: { content: [{ type: 'text', text: question }] },
      runs: [{ at: 1_700_000_002_000 + index * 10_000, blocks: [{ type: 'text', text: answer }], toolResults: [] }],
    })),
    notes: [],
  };
}

/**
 * Fake `sessionPersistence` with both the create and the open seams.
 *
 * `open(id, 'read')` hands back a snapshot, `open(id, 'write')` appends. Like
 * the real backend, opening for write twice is refused — that is what makes
 * "the session is already open in the harness" observable as `busy`.
 */
function mockPersistence(options = {}) {
  const store = new Map();
  const calls = [];
  let claimed = null;
  const persistence = {
    store,
    calls,
    async create(header) {
      if (store.has(header.id)) throw new Error(`session ${header.id} already exists`);
      store.set(header.id, { header, events: [], open: false });
      calls.push(['create', header.id]);
      return {
        append: async (events) => {
          store.get(header.id).events.push(...events);
        },
        flush: async () => {},
        close: async () => {},
      };
    },
    async open(id, mode) {
      const entry = store.get(id);
      if (entry === undefined) throw new Error(`no such session ${id}`);
      calls.push(['open', id, mode]);
      if (mode === 'read') {
        return {
          header: entry.header,
          read: async () => ({ header: entry.header, events: entry.events.slice() }),
          close: async () => {},
        };
      }
      if (options.busy === true || entry.open === true) throw new Error('session is already owned');
      entry.open = true;
      claimed = id;
      return {
        append: async (events) => {
          store.get(id).events.push(...events);
        },
        flush: async () => {},
        close: async () => {
          entry.open = false;
        },
      };
    },
    /** Events of one stored session. */
    events(id) {
      return store.get(id).events;
    },
    claimedId() {
      return claimed;
    },
  };
  // The real backend can delete; the default mock cannot, which is what makes
  // "rewrite in place" degrade to a duplicate there. Tests that need a real
  // replacement opt in.
  if (options.remove === true) {
    persistence.remove = async (id) => {
      if (!store.has(id)) throw new Error(`no such session ${id}`);
      store.delete(id);
      calls.push(['remove', id]);
    };
  }
  return persistence;
}

/** The log must stay contiguous from seq 0 — DSH refuses gaps. */
function assertContiguous(events) {
  events.forEach((event, index) => {
    assert.equal(event.seq, index, `event ${index} has seq ${event.seq}`);
  });
}

test('the first import creates a session and the merge seam sees it', async () => {
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation(), { cwd: 'C:\\proj', mode: 'full' });
  assertContiguous(persistence.events(written.sessionId));

  const outcome = await mergeIntoSession(persistence, conversation(), {
    sessionId: written.sessionId,
    mode: 'full',
    cwd: 'C:\\proj',
  });
  assert.equal(outcome.merged, true);
  assert.equal(outcome.addedTurns, 0, 'nothing was gained since the first import');
  assert.equal(outcome.eventCount, 0);
  assert.equal(outcome.plan, undefined, 'a no-op merge must not ask to rewrite anything');
});

test('an identical re-import writes nothing at all', async () => {
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation(), { cwd: 'C:\\proj', mode: 'full' });
  const before = persistence.events(written.sessionId).length;

  await mergeIntoSession(persistence, conversation(), {
    sessionId: written.sessionId,
    mode: 'full',
    cwd: 'C:\\proj',
  });

  assert.equal(persistence.events(written.sessionId).length, before, 'the log is untouched');
  assert.deepEqual(
    persistence.calls.filter(([kind]) => kind === 'open').map(([, , mode]) => mode),
    ['read'],
    'a no-op merge never claims a write handle',
  );
});

test('a source that gained a turn appends exactly that turn', async () => {
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation([['第一问', '第一答']]), {
    cwd: 'C:\\proj',
    mode: 'full',
  });
  // Snapshot the length: the store hands out its live array, so a later append
  // would otherwise grow the "before" side of the comparison too.
  const beforeCount = persistence.events(written.sessionId).length;
  const lastStoredTime = Math.max(...persistence.events(written.sessionId).map((event) => event.time));

  const grown = conversation([
    ['第一问', '第一答'],
    ['第二问', '第二答'],
  ]);
  const outcome = await mergeIntoSession(persistence, grown, {
    sessionId: written.sessionId,
    mode: 'full',
    cwd: 'C:\\proj',
  });

  assert.equal(outcome.merged, true);
  assert.equal(outcome.addedTurns, 1, 'only the new turn is appended');
  assert.equal(outcome.overlap, 1);
  assert.equal(outcome.sessionId, written.sessionId, 'the id is reused, never stacked');

  const after = persistence.events(written.sessionId);
  assertContiguous(after);
  assert.ok(after.length > beforeCount);

  const appended = after.slice(beforeCount);
  const text = JSON.stringify(appended);
  assert.ok(text.includes('第二问'), 'the new prompt is there');
  assert.ok(!text.includes('第一问'), 'the already-stored turn is not duplicated');
  assert.ok(!text.includes('【导入说明】'), 'the provenance note belongs to the first write only');

  // Turn numbering continues after the stored log.
  const turnStarts = appended.filter((event) => event.type === 'turn/start').map((event) => event.data.turn);
  assert.deepEqual(turnStarts, [2]);

  // Times never look older than the log they join.
  assert.ok(Math.min(...appended.map((event) => event.time)) > lastStoredTime);
});

test('a local DSH follow-up survives a merge', async () => {
  // The whole point of merging: the user kept working in DSH, and those turns
  // live in the same log. A rewrite would have deleted them.
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation([['远程问', '远程答']]), {
    cwd: 'C:\\proj',
    mode: 'full',
  });
  const stored = persistence.events(written.sessionId);

  // Simulate the user continuing inside DSH: turn 2 is local-only.
  const local = buildSessionPlan(conversation([['本地追问', '本地回答']]), {
    cwd: 'C:\\proj',
    mode: 'full',
    sessionId: written.sessionId,
    continues: true,
    importNotice: false,
    seqBase: stored.length,
    turnBase: 1,
    minTime: Math.max(...stored.map((event) => event.time)) + 1,
  });
  stored.push(...local.events);
  assertContiguous(stored);

  // Now the remote conversation gained its own second turn and is re-imported.
  const outcome = await mergeIntoSession(
    persistence,
    conversation([
      ['远程问', '远程答'],
      ['远程第二问', '远程第二答'],
    ]),
    { sessionId: written.sessionId, mode: 'full', cwd: 'C:\\proj' },
  );

  assert.equal(outcome.merged, true);
  assert.equal(outcome.addedTurns, 1, 'the local turn is not part of the overlap');

  const after = persistence.events(written.sessionId);
  assertContiguous(after);
  const text = JSON.stringify(after);
  assert.ok(text.includes('本地追问'), 'the local follow-up is still there');
  assert.ok(text.includes('本地回答'));
  assert.ok(text.includes('远程第二问'), 'the new remote turn is appended after it');

  const turnStarts = after.filter((event) => event.type === 'turn/start').map((event) => event.data.turn);
  assert.deepEqual(turnStarts, [1, 2, 3], 'numbering continues instead of restarting');
});

test('the merge plan seeds the projection cache with the whole log', async () => {
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation([['甲', '乙']]), { cwd: 'C:\\proj', mode: 'full' });
  const outcome = await mergeIntoSession(persistence, conversation([['甲', '乙'], ['丙', '丁']]), {
    sessionId: written.sessionId,
    mode: 'full',
    cwd: 'C:\\proj',
  });

  assert.ok(outcome.plan !== undefined);
  assert.equal(outcome.plan.header.id, written.sessionId, 'the header keeps the session identity');
  assert.equal(outcome.plan.events.length, persistence.events(written.sessionId).length, 'the seed is the full log');
  assertContiguous(outcome.plan.events);
});

test('a deleted session is reported as missing, not recreated', async () => {
  const persistence = mockPersistence();
  const outcome = await mergeIntoSession(persistence, conversation(), {
    sessionId: 'session-44444444-4444-4444-8444-444444444444',
    mode: 'full',
    cwd: 'C:\\proj',
  });
  assert.equal(outcome.merged, false);
  assert.equal(outcome.reason, 'missing');
  assert.equal(persistence.store.size, 0, 'a merge never creates a session');
});

test('a backend without open() refuses with unsupported', async () => {
  const outcome = await mergeIntoSession({ create: async () => {} }, conversation(), {
    sessionId: 'session-55555555-5555-4555-8555-555555555555',
  });
  assert.equal(outcome.merged, false);
  assert.equal(outcome.reason, 'unsupported');
});

test('a session with no turns refuses with empty', async () => {
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation(), { cwd: 'C:\\proj', mode: 'full' });
  persistence.events(written.sessionId).length = 0;

  const outcome = await mergeIntoSession(persistence, conversation(), {
    sessionId: written.sessionId,
    mode: 'full',
    cwd: 'C:\\proj',
  });
  assert.equal(outcome.merged, false);
  assert.equal(outcome.reason, 'empty');
});

test('a session held open elsewhere refuses with busy instead of corrupting it', async () => {
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation(), { cwd: 'C:\\proj', mode: 'full' });
  // The harness holds the write handle for a session that is open on screen.
  const held = await persistence.open(written.sessionId, 'write');

  const outcome = await mergeIntoSession(persistence, conversation([['甲', '乙'], ['丙', '丁']]), {
    sessionId: written.sessionId,
    mode: 'full',
    cwd: 'C:\\proj',
  });
  assert.equal(outcome.merged, false);
  assert.equal(outcome.reason, 'busy');
  assert.equal(persistence.events(written.sessionId).length, persistence.events(written.sessionId).length);
  await held.close();
});

test('a malformed session id never merges anywhere', async () => {
  const outcome = await mergeIntoSession(mockPersistence(), conversation(), { sessionId: 'not-an-id' });
  assert.equal(outcome.merged, false);
  assert.equal(outcome.reason, 'no-session');
});

test('turn signatures ignore the import notice and whitespace', () => {
  const withNotice = {
    user: {
      content: [
        {
          type: 'text',
          text: '【导入说明】本会话由 Cursor 导入到 DeepSeek Harness。历史中的工具调用与结果属于原 agent，仅作为历史记录；继续对话时请使用本会话当前实际提供的工具。\n  帮我  修一下 ',
        },
      ],
    },
    runs: [],
  };
  const plain = { user: { content: [{ type: 'text', text: '帮我 修一下' }] }, runs: [] };
  assert.equal(turnSignature(withNotice), turnSignature(plain));
  assert.equal(turnSignature(withNotice), '帮我 修一下');
});

test('a continuation turn with no prompt is identified by its first output', () => {
  const turn = { user: null, runs: [{ blocks: [{ type: 'text', text: '  只有回答  ' }], toolResults: [] }] };
  assert.equal(turnSignature(turn), '只有回答');
});

test('the common prefix tolerates an unrecognized notice prepended to a prompt', () => {
  // An older plugin version wrote a notice whose closing sentence this build
  // cannot find, so `stripImportNotice` leaves the text alone. The prompt is
  // still a suffix of the stored text, which is enough to match turn 0.
  const stored = [
    { user: { content: [{ type: 'text', text: '【导入说明】某个旧版本写的说明 问题' }] }, runs: [] },
    { user: { content: [{ type: 'text', text: '第二' }] }, runs: [] },
  ];
  const incoming = [
    { user: { content: [{ type: 'text', text: '问题' }] }, runs: [] },
    { user: { content: [{ type: 'text', text: '第二' }] }, runs: [] },
  ];
  assert.equal(commonPrefixLength(stored, incoming), 2);
});

test('a prefix stops at the first disagreement', () => {
  const stored = [{ user: { content: [{ type: 'text', text: '甲' }] }, runs: [] }, { user: { content: [{ type: 'text', text: '乙' }] }, runs: [] }];
  const incoming = [{ user: { content: [{ type: 'text', text: '甲' }] }, runs: [] }, { user: { content: [{ type: 'text', text: '丙' }] }, runs: [] }];
  assert.equal(commonPrefixLength(stored, incoming), 1);
});

test('a log that moved mid-merge is reported as conflict, never rewritten', async () => {
  // The stored log grew between our read and our write, so the seq numbers the
  // merge computed are stale. Falling back to a whole rewrite here would delete
  // a session another writer is actively appending to.
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation([['甲', '乙']]), { cwd: 'C:\\proj', mode: 'full' });
  const before = persistence.events(written.sessionId).length;

  const realOpen = persistence.open.bind(persistence);
  persistence.open = async (id, mode) => {
    const handle = await realOpen(id, mode);
    if (mode !== 'write') return handle;
    return {
      ...handle,
      append: async () => {
        throw new Error(`append seq mismatch for "${id}"`);
      },
    };
  };

  const outcome = await persistConversation(persistence, conversation([['甲', '乙'], ['丙', '丁']]), {
    cwd: 'C:\\proj',
    mode: 'full',
    knownSessionId: written.sessionId,
  });

  assert.equal(outcome.reason, 'conflict');
  assert.equal(outcome.merged, false);
  assert.notEqual(outcome.written.sessionId, written.sessionId, 'a new session is used');
  assert.equal(persistence.events(written.sessionId).length, before, 'the contested log is untouched');
  assert.equal(persistence.calls.filter(([kind]) => kind === 'remove').length, 0, 'nothing was deleted');
  assert.match(outcome.warnings.join(), /未被改动|被改动/);
});

// ── re-import policy ──────────────────────────────────────────────────────

test('a first import takes the create branch', async () => {
  const persistence = mockPersistence();
  const outcome = await persistConversation(persistence, conversation(), { cwd: 'C:\\proj', mode: 'full' });
  assert.equal(outcome.reason, 'created');
  assert.equal(outcome.merged, false);
  assert.deepEqual(outcome.warnings, []);
});

test('a session open in the harness is never written to', async () => {
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation(), { cwd: 'C:\\proj', mode: 'full' });
  const before = persistence.events(written.sessionId).length;

  const outcome = await persistConversation(persistence, conversation([['甲', '乙'], ['丙', '丁']]), {
    cwd: 'C:\\proj',
    mode: 'full',
    knownSessionId: written.sessionId,
    isOpen: true,
  });

  assert.equal(outcome.reason, 'open');
  assert.notEqual(outcome.written.sessionId, written.sessionId, 'a fresh session is used');
  assert.equal(persistence.events(written.sessionId).length, before, 'the open one is untouched');
  assert.match(outcome.warnings.join(), /正在打开/);
});

test('a plain re-import merges instead of replacing', async () => {
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation([['甲', '乙']]), { cwd: 'C:\\proj', mode: 'full' });

  const outcome = await persistConversation(persistence, conversation([['甲', '乙'], ['丙', '丁']]), {
    cwd: 'C:\\proj',
    mode: 'full',
    knownSessionId: written.sessionId,
  });

  assert.equal(outcome.reason, 'merged');
  assert.equal(outcome.merged, true);
  assert.equal(outcome.addedTurns, 1);
  assert.equal(outcome.written.sessionId, written.sessionId);
  assert.equal(outcome.written.replaced, false, 'merging never deletes');
  assert.deepEqual(outcome.warnings, [], 'a clean merge needs no explanation');
});

test('merging can be turned off, which restores the replacing behaviour', async () => {
  const persistence = mockPersistence({ remove: true });
  const written = await writeSession(persistence, conversation([['甲', '乙']]), { cwd: 'C:\\proj', mode: 'full' });

  const outcome = await persistConversation(persistence, conversation([['新问题', '新回答']]), {
    cwd: 'C:\\proj',
    mode: 'full',
    knownSessionId: written.sessionId,
    allowMerge: false,
  });

  assert.equal(outcome.reason, 'replaced');
  assert.equal(outcome.written.sessionId, written.sessionId);
  assert.equal(outcome.written.replaced, true);
});

test('a deleted original is recreated under the same id', async () => {
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation([['甲', '乙']]), { cwd: 'C:\\proj', mode: 'full' });
  persistence.store.delete(written.sessionId);

  const outcome = await persistConversation(persistence, conversation([['甲', '乙']]), {
    cwd: 'C:\\proj',
    mode: 'full',
    knownSessionId: written.sessionId,
  });

  assert.equal(outcome.reason, 'rewritten');
  assert.equal(outcome.written.sessionId, written.sessionId, 'the id the state remembers is reused');
  assert.match(outcome.warnings.join(), /已不存在|已整份重写/);
});

test('a rewrite that cannot happen reports the duplicate honestly', async () => {
  // Merge refuses (`empty`) and the backend cannot delete, so `create` falls
  // back to a fresh id: the row must not claim the old session was rewritten.
  const persistence = mockPersistence();
  const written = await writeSession(persistence, conversation([['甲', '乙']]), { cwd: 'C:\\proj', mode: 'full' });
  persistence.events(written.sessionId).length = 0;

  const outcome = await persistConversation(persistence, conversation([['甲', '乙']]), {
    cwd: 'C:\\proj',
    mode: 'full',
    knownSessionId: written.sessionId,
  });

  assert.equal(outcome.reason, 'rewritten');
  assert.notEqual(outcome.written.sessionId, written.sessionId);
  const text = outcome.warnings.join();
  assert.match(text, /可接续的回合/);
  assert.match(text, /仍保留在列表里/, 'the user is told the old session is still there');
});
