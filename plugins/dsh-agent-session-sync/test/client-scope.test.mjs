/**
 * Browser-half test: the export page must only offer the sessions the DSH page
 * lists.
 *
 * The bundle is loaded the way the harness loads it — through
 * `window.__ModuleLoader__`, with React and the UI primitives injected as the
 * factory's `require` — so this exercises the shipped artifact, not the
 * sources. Nothing is rendered: the assertion is on the `pageSessions` helper
 * the slot hands to the panel, which is where the scope is decided.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const BUNDLE = path.resolve(import.meta.dirname, '..', 'lib', 'client.js');

/** A React stand-in: the panel's hooks are never called here. */
function reactStub() {
  const noop = () => undefined;
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: noop,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    createContext: () => ({ Provider: 'Provider' }),
  };
}

/**
 * Load `lib/client.js` and return the plugin exports.
 * @param deps - modules the factory `require`s.
 */
function loadPlugin(deps) {
  let exported;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => {
          exported = factory((name) => {
            if (!(name in deps)) throw new Error(`unexpected module: ${name}`);
            return deps[name];
          });
        },
      },
    },
    console,
  };
  vm.runInNewContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: BUNDLE });
  assert.ok(exported !== undefined, 'the bundle must register a factory');
  return exported;
}

/** A browser context recording the registered slots. */
function fakeCtx(sessionList) {
  const registered = [];
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (spec, component) => {
        registered.push({ spec, component });
        return { ...spec, dispose: () => {} };
      },
    },
    sessions: sessionList === undefined ? undefined : { list: sessionList },
  };
  return { ctx, registered };
}

/** The page feed: `byId` plus the ids the sidebar renders. */
function feed(rows) {
  const byId = {};
  for (const row of rows) byId[row.id] = row;
  return {
    getSnapshot: () => ({ ids: rows.map((row) => row.id), byId, phase: 'ready' }),
    subscribe: () => () => {},
  };
}

test('the export scope follows the page session list', () => {
  const plugin = loadPlugin({
    react: reactStub(),
    '@deepseek-ai/dsh-client-ui-primitives': {},
  });

  const { ctx, registered } = fakeCtx(
    feed([
      { id: 'session-listed', displayTitle: '页面里的会话' },
      // A sub-agent child: the page reaches it from its parent row only.
      { id: 'session-child', displayTitle: '子会话', origin: 'subagent', parentId: 'session-listed' },
      // A blank session has no prompt yet, so there is nothing to import.
      { id: 'session-blank', displayTitle: '', blank: true },
    ]),
  );
  plugin.apply(ctx);

  const main = registered.find((entry) => entry.spec.name === 'main');
  assert.ok(main !== undefined, 'the main page must be registered');
  const props = main.spec.inject();
  assert.ok(props.pageSessions !== undefined, 'the panel needs the page session feed');

  const scope = props.pageSessions.read();
  assert.equal(scope.available, true);
  // The ids come from the bundle's realm, so copy before comparing.
  assert.deepEqual([...scope.ids], ['session-listed']);
});

test('a DSH release without a session-list feed does not filter at all', () => {
  const plugin = loadPlugin({
    react: reactStub(),
    '@deepseek-ai/dsh-client-ui-primitives': {},
  });

  const { ctx, registered } = fakeCtx(undefined);
  plugin.apply(ctx);

  const main = registered.find((entry) => entry.spec.name === 'main');
  const props = main.spec.inject();
  const scope = props.pageSessions.read();
  assert.equal(scope.available, false, 'no feed means "list everything"');
  assert.deepEqual([...scope.ids], []);
  // Subscribing must stay harmless when there is nothing to subscribe to.
  assert.equal(typeof props.pageSessions.subscribe(() => {}), 'function');
});

test('the page scope follows the feed while the panel is open', () => {
  const plugin = loadPlugin({
    react: reactStub(),
    '@deepseek-ai/dsh-client-ui-primitives': {},
  });

  const listeners = new Set();
  const rows = [{ id: 'session-a', displayTitle: 'A' }];
  const pageFeed = {
    getSnapshot: () => {
      const byId = {};
      for (const row of rows) byId[row.id] = row;
      return { ids: rows.map((row) => row.id), byId, phase: 'ready' };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Simulate the page's own re-render after the catalog changed. */
    emit: () => {
      for (const listener of listeners) listener();
    },
  };

  const { ctx, registered } = fakeCtx(pageFeed);
  plugin.apply(ctx);

  const main = registered.find((entry) => entry.spec.name === 'main');
  const props = main.spec.inject();
  assert.deepEqual([...props.pageSessions.read().ids], ['session-a']);

  // The panel subscribes on mount; a session created while it is open must
  // join the scope, so "开始导入" can never target a session the page hides.
  let bites = 0;
  const unsubscribe = props.pageSessions.subscribe(() => {
    bites += 1;
  });
  assert.equal(listeners.size, 1, 'the panel must be able to watch the feed');

  rows.push({ id: 'session-b', displayTitle: 'B' });
  pageFeed.emit();
  assert.equal(bites, 1);
  assert.deepEqual([...props.pageSessions.read().ids], ['session-a', 'session-b']);

  // A session removed from the page must leave the scope as well.
  rows.length = 1;
  pageFeed.emit();
  assert.deepEqual([...props.pageSessions.read().ids], ['session-a']);

  unsubscribe();
  assert.equal(listeners.size, 0);
});
