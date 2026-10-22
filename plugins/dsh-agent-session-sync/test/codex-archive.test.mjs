import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * Codex never removes a rollout from `sessions/` when a conversation is put
 * away: it only sets `threads.archived` in `state_5.sqlite`. The provider must
 * skip those rollouts, otherwise archived conversations keep appearing as
 * importable.
 *
 * The fixture copies the real `state_5.sqlite` schema from the installed Codex
 * data so the query runs against the actual column shape; when Codex is not
 * installed the test is skipped instead of faking a schema.
 */
test('Codex hides archived threads from list() and load()', async (t) => {
  const home = process.env.HOME ?? '';
  const sourceDb = join(home, '.codex', 'state_5.sqlite');
  if (!existsSync(sourceDb)) {
    t.skip('no local Codex database to copy the schema from');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'codex-archive-'));
  mkdirSync(join(root, 'sessions', '2026', '01', '01'), { recursive: true });
  copyFileSync(sourceDb, join(root, 'state_5.sqlite'));

  const liveId = 'aaaaaaaa-1111-2222-3333-444444444444';
  const archivedId = 'bbbbbbbb-1111-2222-3333-444444444444';
  const makeRollout = (id) =>
    writeFileSync(
      join(root, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${id}.jsonl`),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd: 'C:\\project', timestamp: '2026-01-01T00:00:00.000Z' },
      })}\n${JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `hello ${id}` }] },
      })}\n`,
    );
  makeRollout(liveId);
  makeRollout(archivedId);

  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(root, 'state_5.sqlite'));
  database.exec('DELETE FROM threads');
  const columns = database.prepare('PRAGMA table_info(threads)').all();
  const insert = (id, archived) => {
    const row = { id, archived, archived_at: archived === 1 ? 1_700 : null };
    const names = columns
      .filter((column) => column.name in row || (column.notnull === 1 && column.dflt_value === null))
      .map((column) => column.name);
    database
      .prepare(`INSERT INTO threads (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...names.map((name) => (name in row ? row[name] : 0)));
  };
  insert(liveId, 0);
  insert(archivedId, 1);
  database.close();

  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    const codex = await import(`../lib/host/providers/codex.js?codex-test=${Date.now()}`);

    const summaries = await codex.list();
    const ids = summaries.map((entry) => entry.id);
    assert.ok(ids.includes(liveId), 'live thread must be listed');
    assert.ok(!ids.includes(archivedId), 'archived thread must not be listed');

    const conversation = await codex.load(liveId);
    assert.equal(conversation.source, 'codex');

    await assert.rejects(
      () => codex.load(archivedId),
      /已归档/,
      'an archived thread must not be loadable',
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});