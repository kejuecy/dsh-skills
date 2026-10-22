/**
 * Re-import behaviour: importing the same remote conversation twice must replace
 * the earlier DSH session rather than piling up duplicates.
 *
 * The persistence seam is mocked because the real one only exists inside the
 * harness. The mock is strict on purpose: `create` throws for an id that already
 * exists, which is what forces the overwrite path to actually delete first.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeSession } from '../lib/host/writer.js';

/** A conversation with one prompt and one reply. */
function conversation(question = '问题', answer = '回答') {
  return {
    source: 'codex',
    id: 'remote-1',
    title: '重复导入',
    createdAt: 1_700_000_000_000,
    cwd: 'C:\\proj',
    turns: [
      {
        at: 1_700_000_001_000,
        user: { content: [{ type: 'text', text: question }] },
        runs: [{ at: 1_700_000_002_000, blocks: [{ type: 'text', text: answer }], toolResults: [] }],
      },
    ],
    notes: [],
  };
}

/**
 * Fake `sessionPersistence`.
 * @param options - `{ supportsRemove }` toggles the deletion capability.
 */
function mockPersistence(options = {}) {
  const sessions = new Map();
  const calls = [];
  const supportsRemove = options.supportsRemove !== false;
  const persistence = {
    calls,
    sessions,
    async create(header) {
      if (sessions.has(header.id)) {
        const error = new Error(`session ${header.id} already exists`);
        error.code = 'exists';
        throw error;
      }
      sessions.set(header.id, []);
      calls.push(['create', header.id]);
      return {
        append: async (events) => {
          sessions.get(header.id).push(...events);
        },
        flush: async () => {},
        close: async () => {},
      };
    },
  };
  if (supportsRemove) {
    persistence.remove = async (id) => {
      if (!sessions.has(id)) {
        const error = new Error(`no such session ${id}`);
        error.code = 'missing';
        throw error;
      }
      sessions.delete(id);
      calls.push(['remove', id]);
    };
  }
  return persistence;
}

test('a first import creates a new session', async () => {
  const persistence = mockPersistence();
  const result = await writeSession(persistence, conversation(), { cwd: 'C:\\proj', mode: 'full' });
  assert.match(result.sessionId, /^session-/);
  assert.equal(result.replaced, false, 'nothing was replaced on the first import');
  assert.equal(persistence.sessions.size, 1);
});

test('re-importing replaces the previous session in place', async () => {
  const persistence = mockPersistence();

  const first = await writeSession(persistence, conversation('第一次', '旧回答'), { cwd: 'C:\\proj', mode: 'full' });
  const firstEvents = persistence.sessions.get(first.sessionId).length;
  assert.ok(firstEvents > 0);

  // Same remote conversation, now imported again.
  const second = await writeSession(persistence, conversation('第二次', '新回答'), {
    cwd: 'C:\\proj',
    mode: 'full',
    sessionId: first.sessionId,
    overwrite: true,
  });

  assert.equal(second.replaced, true, 'the old session must be removed');
  assert.equal(second.sessionId, first.sessionId, 'the id is reused, not stacked');
  assert.equal(persistence.sessions.size, 1, 'no duplicate session may remain');

  // The transcript is the new one, not the old one plus an append.
  const transcript = JSON.stringify(persistence.sessions.get(first.sessionId));
  assert.ok(transcript.includes('新回答'));
  assert.ok(!transcript.includes('旧回答'), 'old content must be gone');

  const removals = persistence.calls.filter(([kind]) => kind === 'remove');
  assert.equal(removals.length, 1);
});

test('without a backend delete, a re-import falls back to a new session', async () => {
  // Some persistence backends expose no removal entry point. Losing the import
  // would be worse than leaving the old session, so it degrades and reports it.
  const persistence = mockPersistence({ supportsRemove: false });

  const first = await writeSession(persistence, conversation('第一次'), { cwd: 'C:\\proj', mode: 'full' });
  const second = await writeSession(persistence, conversation('第二次'), {
    cwd: 'C:\\proj',
    mode: 'full',
    sessionId: first.sessionId,
    overwrite: true,
  });

  assert.equal(second.replaced, false, 'nothing was deleted');
  assert.notEqual(second.sessionId, first.sessionId, 'a fresh id is used instead');
  assert.equal(persistence.sessions.size, 2, 'both sessions exist; the caller warns the user');
});

test('overwrite is off by default so a plain id reuse never deletes', async () => {
  const persistence = mockPersistence();
  const first = await writeSession(persistence, conversation('第一次'), { cwd: 'C:\\proj', mode: 'full' });
  const second = await writeSession(persistence, conversation('第二次'), {
    cwd: 'C:\\proj',
    mode: 'full',
    sessionId: first.sessionId,
  });

  assert.equal(second.replaced, false);
  assert.equal(persistence.calls.filter(([kind]) => kind === 'remove').length, 0);
});

test('a malformed id is ignored instead of creating an unreachable session', async () => {
  const persistence = mockPersistence();
  const result = await writeSession(persistence, conversation(), {
    cwd: 'C:\\proj',
    mode: 'full',
    sessionId: 'not-a-session-id',
    overwrite: true,
  });
  assert.match(result.sessionId, /^session-[0-9a-f-]{8,}$/i, 'caller id must be normalized away');
});

/**
 * Fake backend without a delete method, but with `locate()` — the shape the
 * real JSONL backend has. Removal then has to go through the transcript path,
 * which is exactly where a wrong path would be unrecoverable.
 */
function locateOnlyPersistence(locateTo) {
  const sessions = new Map();
  return {
    sessions,
    async create(header) {
      if (sessions.has(header.id)) throw new Error('exists');
      sessions.set(header.id, []);
      return { append: async () => {}, flush: async () => {}, close: async () => {} };
    },
    async locate() {
      return { path: locateTo };
    },
  };
}

test('re-import removes the old transcript through locate()', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-'));
  const dir = path.join(root, 'sessions', '--ws--', 'session-old');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'old');

  const persistence = locateOnlyPersistence(dir);
  const result = await writeSession(persistence, conversation('重新导入'), {
    cwd: 'C://proj',
    mode: 'full',
    sessionId: 'session-11111111-1111-4111-8111-111111111111',
    overwrite: true,
  });

  assert.equal(result.replaced, true);
  assert.equal(result.removedVia, 'locate');
  assert.equal(fs.existsSync(dir), false, 'the old session directory is gone');
  fs.rmSync(root, { recursive: true, force: true });
});

test('locate() pointing outside a sessions directory is refused', async () => {
  // A backend bug or a crafted path must not let the writer delete arbitrary
  // directories. The import still succeeds, just as a new session.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  const precious = path.join(root, 'important');
  fs.mkdirSync(precious, { recursive: true });
  fs.writeFileSync(path.join(precious, 'keep.txt'), 'do not delete');

  const persistence = locateOnlyPersistence(precious);
  const result = await writeSession(persistence, conversation(), {
    cwd: 'C://proj',
    mode: 'full',
    sessionId: 'session-22222222-2222-4222-8222-222222222222',
    overwrite: true,
  });

  assert.equal(result.replaced, false, 'refused to delete');
  assert.equal(fs.existsSync(precious), true, 'the directory must survive');
  assert.equal(fs.readFileSync(path.join(precious, 'keep.txt'), 'utf8'), 'do not delete');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a symlinked transcript is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-'));
  const real = path.join(root, 'sessions', '--ws--', 'real');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'session.v4.jsonl.zstd'), 'real');
  const link = path.join(root, 'sessions', '--ws--', 'link');
  try {
    fs.symlinkSync(real, link, 'dir');
  } catch {
    fs.rmSync(root, { recursive: true, force: true });
    return; // symlinks may be unavailable on this filesystem
  }

  const persistence = locateOnlyPersistence(link);
  const result = await writeSession(persistence, conversation(), {
    cwd: 'C://proj',
    mode: 'full',
    sessionId: 'session-33333333-3333-4333-8333-333333333333',
    overwrite: true,
  });

  assert.equal(result.replaced, false, 'a symlink must never be followed');
  assert.equal(fs.existsSync(path.join(real, 'session.v4.jsonl.zstd')), true, 'the target survives');
  fs.rmSync(root, { recursive: true, force: true });
});
