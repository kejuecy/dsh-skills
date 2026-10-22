import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * ZCode keeps removed conversations in its database and only stamps
 * `time_deleted`. The provider must hide those rows from list() and refuse to
 * load them, otherwise a conversation the user deleted in the app would still
 * show up as importable.
 *
 * The fixture rebuilds the schema from the installed ZCode database so the
 * queries run against the real column shape. When ZCode is absent the test is
 * skipped instead of faking a schema that would drift from the app.
 */
test('ZCode hides soft-deleted sessions from list() and load()', async (t) => {
  const home = process.env.HOME ?? '';
  const sourceDb = join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  if (!existsSync(sourceDb)) {
    t.skip('no local ZCode database to copy the schema from');
    return;
  }

  const { DatabaseSync } = await import('node:sqlite');
  const source = new DatabaseSync(sourceDb, { readOnly: true });
  const ddl = source
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part')")
    .all()
    .map((row) => row.sql)
    .filter((sql) => typeof sql === 'string');
  source.close();
  assert.equal(ddl.length, 3, 'expected session/message/part tables in the real schema');

  const root = mkdtempSync(join(tmpdir(), 'zcode-cli-'));
  const dbDir = join(root, 'cli', 'db');
  mkdirSync(dbDir, { recursive: true });
  const database = new DatabaseSync(join(dbDir, 'db.sqlite'));
  for (const sql of ddl) database.exec(sql);

  // Only the columns a session row must fill are supplied; NOT NULL columns
  // without defaults get a neutral value.
  const columns = database.prepare('PRAGMA table_info(session)').all();
  assert.ok(columns.some((column) => column.name === 'time_deleted'), 'real schema must expose time_deleted');
  const insert = (overrides) => {
    const row = {};
    for (const column of columns) {
      if (column.name in overrides) row[column.name] = overrides[column.name];
      else if (column.notnull === 1 && column.dflt_value === null) row[column.name] = 0;
    }
    const names = Object.keys(row);
    database
      .prepare(`INSERT INTO session (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...names.map((name) => row[name]));
  };
  insert({ id: 'live-1', title: 'Live session', directory: 'C:\\project', time_created: 1_000, time_updated: 2_000, time_archived: null, time_deleted: null });
  insert({ id: 'gone-1', title: 'Deleted session', directory: 'C:\\project', time_created: 1_000, time_updated: 1_500, time_archived: null, time_deleted: 1_700 });
  insert({ id: 'arch-1', title: 'Archived session', directory: 'C:\\project', time_created: 1_000, time_updated: 1_600, time_archived: 1_650, time_deleted: null });
  database.close();

  const previous = process.env.ZCODE_HOME;
  process.env.ZCODE_HOME = root;
  try {
    const zcode = await import(`../lib/host/providers/zcode.js?zcode-test=${Date.now()}`);

    const summaries = await zcode.list();
    const ids = summaries.map((entry) => entry.id).sort();
    assert.deepEqual(ids, ['arch-1', 'live-1'], 'soft-deleted session must not appear in list()');

    // Archived sessions stay visible (ZCode still lists them), just flagged.
    assert.equal(summaries.find((entry) => entry.id === 'arch-1').isArchived, true);

    await assert.rejects(
      () => zcode.load('gone-1'),
      /已在 ZCode 中删除/,
      'a soft-deleted session must not be loadable',
    );
  } finally {
    if (previous === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = previous;
  }
});