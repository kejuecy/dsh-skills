/**
 * Workspace grouping for imported sessions.
 *
 * DSH's sidebar is grouped by *registered Workspaces*, not by the `cwd` a
 * session header carries, so an imported session lands in "未分组" unless it is
 * attached to one. These tests pin that behaviour without a running harness:
 * the registry is a small stand-in with the same surface the real service
 * exposes (`list()`, `create(path, title)`, `entity.attachSession(id)`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sourceProjectDirectory } from '../lib/host/platform.js';
import { ImportService } from '../lib/host/service.js';

/** A workspace registry stand-in: reuse by path, attach records the call. */
function fakeRegistry(initialPaths = []) {
  const entities = initialPaths.map((dir, index) => ({
    id: `ws-${index + 1}`,
    path: dir,
    title: path.basename(dir),
    attached: [],
    async attachSession(sessionId) {
      this.attached.push(sessionId);
    },
  }));
  return {
    entities,
    list: () => entities,
    async create(dir, title) {
      const existing = entities.find((entity) => entity.path === dir);
      if (existing !== undefined) return existing;
      const entity = {
        id: `ws-${entities.length + 1}`,
        path: dir,
        title,
        attached: [],
        async attachSession(sessionId) {
          this.attached.push(sessionId);
        },
      };
      entities.push(entity);
      return entity;
    },
  };
}

/** A service whose only collaborator is the workspace registry. */
function serviceWith(registry) {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-test-'));
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
  };
  return {
    service: new ImportService(ctx),
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    },
  };
}

/** A temp directory that really exists, so the workspace checks can stat it. */
function projectDir(name = 'DeepHarness') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-'));
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('a conversation with a real project directory reports that directory', () => {
  const dir = projectDir();
  assert.equal(sourceProjectDirectory(dir), dir);
  // A `file://` cwd keeps the URI's own separators; only the target directory
  // is what matters (the workspace registry canonicalizes with `realpath`).
  const fromUri = sourceProjectDirectory(`file:///${dir.replaceAll('\\', '/')}`);
  assert.equal(fromUri.replaceAll('\\', '/').toLowerCase(), dir.replaceAll('\\', '/').toLowerCase());
});

test('a conversation without a project directory reports none', () => {
  assert.equal(sourceProjectDirectory(undefined), undefined);
  assert.equal(sourceProjectDirectory(''), undefined);
  assert.equal(sourceProjectDirectory('relative/path'), undefined);
  // A directory that no longer exists must not become a workspace.
  assert.equal(sourceProjectDirectory(path.join(os.tmpdir(), 'dsh-does-not-exist-42')), undefined);
  // Home is where project-less sessions land — treating it as a project would
  // make "未分类" disappear from the sidebar. Every spelling of it must be
  // excluded, including the forward-slash and duplicated-separator forms that
  // other agents store verbatim.
  assert.equal(sourceProjectDirectory(os.homedir()), undefined);
  assert.equal(sourceProjectDirectory(os.homedir().replaceAll('\\', '/')), undefined);
  assert.equal(sourceProjectDirectory(`${os.homedir().replaceAll('\\', '/')}//`), undefined);
});

test('an imported session is attached to a workspace it creates', async () => {
  const dir = projectDir();
  const registry = fakeRegistry();
  const { service, restore } = serviceWith(registry);
  try {
    const result = await service.attachToWorkspace('session-new', { cwd: dir });
    assert.deepEqual(result, { title: 'DeepHarness', created: true, error: null });
    assert.equal(registry.entities.length, 1);
    assert.deepEqual(registry.entities[0].attached, ['session-new']);
  } finally {
    restore();
  }
});

test('an existing workspace for the same directory is reused, not duplicated', async () => {
  const dir = projectDir('已有项目');
  const registry = fakeRegistry([dir]);
  const { service, restore } = serviceWith(registry);
  try {
    const result = await service.attachToWorkspace('session-two', { cwd: dir });
    assert.deepEqual(result, { title: '已有项目', created: false, error: null });
    assert.equal(registry.entities.length, 1);
    assert.deepEqual(registry.entities[0].attached, ['session-two']);
  } finally {
    restore();
  }
});

test('a project-less conversation stays ungrouped', async () => {
  const registry = fakeRegistry();
  const { service, restore } = serviceWith(registry);
  try {
    assert.equal(await service.attachToWorkspace('session-x', { cwd: os.homedir() }), null);
    assert.equal(await service.attachToWorkspace('session-y', {}), null);
    assert.equal(registry.entities.length, 0, 'no workspace may be invented');
  } finally {
    restore();
  }
});

test('a registry that cannot attach degrades to a warning, not a failed import', async () => {
  const dir = projectDir();
  const registry = fakeRegistry();
  registry.entities.push({
    id: 'ws-broken',
    path: dir,
    title: 'DeepHarness',
    async attachSession() {
      throw new Error('header carries no cwd to validate against');
    },
  });
  registry.list = () => [registry.entities[0]];
  const { service, restore } = serviceWith(registry);
  try {
    const result = await service.attachToWorkspace('session-z', { cwd: dir });
    assert.equal(result.created, false);
    assert.match(result.error, /no cwd/);
  } finally {
    restore();
  }
});

test('a profile without a workspace service reports it instead of throwing', async () => {
  const dir = projectDir();
  const { service, restore } = serviceWith(undefined);
  try {
    const result = await service.attachToWorkspace('session-q', { cwd: dir });
    assert.equal(result.error, '当前 DSH 组合没有工作区服务');
  } finally {
    restore();
  }
});
