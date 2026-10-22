import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * Cursor keeps archived composers in `composerHeaders` (plus a non-UUID
 * `empty-state-draft` placeholder for the blank chat pane). Its own panel hides
 * both, so the importer must not offer them — otherwise conversations the user
 * put away show up as importable.
 */
test('Cursor hides archived composers and the draft placeholder from list()', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'cursor-appdata-'));
  const globalStorage = join(appData, 'Cursor', 'User', 'globalStorage');
  mkdirSync(globalStorage, { recursive: true });

  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(globalStorage, 'state.vscdb'));
  database.exec('CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT)');
  database.exec('CREATE TABLE cursorDiskKV (key TEXT, value TEXT)');
  database.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)');

  const header = (id, archived) =>
    JSON.stringify({ type: 'head', composerId: id, createdAt: 1_700_000_000_000, lastUpdatedAt: 1_700_000_100_000 });
  const insert = database.prepare(
    'INSERT INTO composerHeaders (composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value) VALUES (?, 1700000000000, 1700000100000, ?, 0, ?, ?)',
  );
  insert.run('live-1111', 0, 10, header('live-1111', 0));
  insert.run('arch-2222', 1, 9, header('arch-2222', 1));
  insert.run('empty-state-draft', 0, 8, header('empty-state-draft', 0));
  database.close();

  const previous = process.env.APPDATA;
  process.env.APPDATA = appData;
  try {
    const cursor = await import(`../lib/host/providers/cursor.js?cursor-test=${Date.now()}`);
    const summaries = await cursor.list();
    const ids = summaries.map((entry) => entry.id);
    assert.ok(ids.includes('live-1111'), 'live composer must be listed');
    assert.ok(!ids.includes('arch-2222'), 'archived composer must not be listed');
    assert.ok(!ids.includes('empty-state-draft'), 'draft placeholder must not be listed');

    await assert.rejects(
      () => cursor.load('arch-2222'),
      /已归档/,
      'an archived composer must not be loadable',
    );
  } finally {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
  }
});