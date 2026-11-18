import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';

function statusHtml() {
  const data = { page: { components: [{ component_id: 'api', name: 'API' }] }, active_changes: [], changes: [], component_uptimes: [], initialDataUpdatedAt: 123 };
  return `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(data))}])</script>`;
}

/** Let the host half's async refresh (fetch → body → parse) finish. */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await setImmediate();
}

export async function host(entryConfig, { fail = false, fetch: fetchImpl } = {}) {
  const timers = new Set(), cleanup = [], handlers = new Map();
  let route, failFetch = fail;
  const interval = (callback, delay) => {
    const timer = { callback, delay };
    timers.add(timer);
    return () => timers.delete(timer);
  };
  const ctx = {
    setInterval: interval,
    inject() { throw new Error('the host half must not inject a settings service'); },
    on(event, callback) { handlers.set(event, callback); },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') cleanup.push(dispose); return dispose; },
    webServer: { register(value) { route = value; return () => { route = null; }; } },
    logger: { info() {}, warn() {} },
  };
  const fetches = [];
  const defaultFetch = async (url) => {
    fetches.push(url);
    if (failFetch) throw new Error('upstream unavailable');
    return { ok: true, text: async () => statusHtml() };
  };
  const fetchFn = async (url) => {
    if (fetchImpl === undefined) return defaultFetch(url);
    fetches.push(url);
    return fetchImpl(url);
  };
  const context = vm.createContext({
    AbortSignal,
    URL,
    TextEncoder,
    TextDecoder,
    fetch: fetchFn,
  });
  const schema = () => ({ default() { return this; }, min() { return this; }, max() { return this; }, volatile() { return this; } });
  const schemastery = new vm.SyntheticModule(['default'], function () { this.setExport('default', { object: value => value, string: schema, number: schema }); }, { context });
  const parser = new vm.SourceTextModule(await readFile(new URL('../lib/parser.js', import.meta.url), 'utf8'), { context });
  const plugin = new vm.SourceTextModule(await readFile(new URL('../lib/index.js', import.meta.url), 'utf8'), { context });
  await plugin.link(name => {
    if (name === '@deepseek-ai/schemastery') return schemastery;
    if (name === './parser.js') return parser;
    throw new Error(`Unexpected import: ${name}`);
  });
  await plugin.evaluate();
  plugin.namespace.apply(ctx, entryConfig);
  await setImmediate();
  return {
    timers,
    handlers,
    context,
    fetches,
    failFetch() { failFetch = true; },
    async tick() { [...timers][0].callback(); await setImmediate(); },
    async response() {
      let status, body;
      assert.equal(route.path, '/deepseek-status/current');
      await route.handler({}, { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } });
      assert.equal(status, 200);
      return body;
    },
    dispose() { for (const dispose of cleanup.reverse()) dispose(); },
  };
}

test('host half imports without any settings package', async () => {
  // The vm linker above throws on an unexpected import, so reaching this line
  // means lib/index.js no longer imports @deepseek-ai/dsh-settings, and apply()
  // never injects a settings service.
  const plugin = await host({});
  assert.equal(plugin.timers.size, 1);
  plugin.dispose();
  assert.equal(plugin.timers.size, 0);
});

test('the row config sets one poller delay', async () => {
  const plugin = await host({ pollIntervalMs: 90000 });
  assert.equal(plugin.timers.size, 1);
  assert.equal([...plugin.timers][0].delay, 90000);
  assert.equal((await plugin.response()).overall, 'operational');
  plugin.dispose();
  assert.equal(plugin.timers.size, 0);
});

test('a missing row config falls back to the documented defaults', async () => {
  const plugin = await host(undefined);
  assert.equal(plugin.timers.size, 1);
  assert.equal([...plugin.timers][0].delay, 60000);
  plugin.dispose();
});

test('an unknown config shape cannot produce a broken delay', async () => {
  const plugin = await host({ pollIntervalMs: 0, statusUrl: '', timeoutMs: -1 });
  assert.equal([...plugin.timers][0].delay, 60000);
  plugin.dispose();
});

test('upstream failure preserves the last snapshot and reports the failure', async () => {
  const plugin = await host({ pollIntervalMs: 60000 });
  const before = await plugin.response();
  plugin.failFetch();
  await plugin.tick();
  const after = await plugin.response();
  assert.equal(after.fetchedAt, before.fetchedAt);
  assert.deepEqual(after.components, before.components);
  assert.equal(after.error, 'upstream unavailable');
  plugin.dispose();
});

test('volatile config references are read through get()', async () => {
  // This is the shape the Host hands to apply() once the Config fields are
  // `.volatile()`: each field is a stable reference whose current value is read
  // through get(). Reading them as plain numbers would compare an object with
  // Number.isFinite and silently fall back to the default.
  const ref = (value) => ({ value, get() { return this.value; } });
  const plugin = await host({
    statusUrl: ref('https://status.deepseek.com/'),
    pollIntervalMs: ref(90000),
    timeoutMs: ref(20000),
  });
  assert.equal([...plugin.timers][0].delay, 90000);
  plugin.dispose();
});

test('a saved settings edit re-arms the poller without a restart', async () => {
  // Cordis announces a volatile-only config commit as `loader/volatile-update`
  // instead of remounting the fiber, so the handler must re-arm from the live
  // references. Firing the event is how the Host reports a saved form edit.
  const ref = (value) => ({ value, get() { return this.value; } });
  const pollIntervalMs = ref(60000);
  const plugin = await host({ pollIntervalMs });
  assert.equal([...plugin.timers][0].delay, 60000);

  const onVolatileUpdate = plugin.handlers.get('loader/volatile-update');
  assert.equal(typeof onVolatileUpdate, 'function', 'the poller must subscribe to loader/volatile-update');

  pollIntervalMs.value = 120000; // what the committed reference now reads
  onVolatileUpdate();
  assert.equal([...plugin.timers][0].delay, 120000);

  plugin.dispose();
  assert.equal(plugin.timers.size, 0);
});

function configRef(value) {
  return { value, get() { return this.value; } };
}

function oversizedReaderBody() {
  const chunk = new Uint8Array(64 * 1024);
  let sent = 0;
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (sent > 2 * 1024 * 1024) return { done: true, value: undefined };
            sent += chunk.byteLength;
            return { done: false, value: chunk };
          },
          async cancel() {},
        };
      },
    },
  };
}

test('the route reports the configured status page for the panel link', async () => {
  const plugin = await host({ statusUrl: 'https://status.example.com/' });
  assert.equal((await plugin.response()).statusUrl, 'https://status.example.com/');
  assert.equal(plugin.fetches[0], 'https://status.example.com/');
  plugin.dispose();
});

test('a non-http status page falls back to the default', async () => {
  const plugin = await host({ statusUrl: 'file:///etc/passwd' });
  assert.equal((await plugin.response()).statusUrl, 'https://status.deepseek.com/');
  assert.equal(plugin.fetches[0], 'https://status.deepseek.com/');
  plugin.dispose();
});

test('a response over 2 MiB is rejected and the last snapshot is kept', async () => {
  let calls = 0;
  const plugin = await host({}, {
    fetch: async () => {
      calls += 1;
      if (calls === 1) return { ok: true, text: async () => statusHtml() };
      return { ok: true, ...oversizedReaderBody() };
    },
  });
  const before = await plugin.response();
  assert.ok(before.fetchedAt, 'the first fetch must produce a snapshot');
  await plugin.tick();
  await settle(16);
  const after = await plugin.response();
  assert.equal(after.fetchedAt, before.fetchedAt, 'the good snapshot must survive');
  assert.match(after.error, /exceeds 2097152 bytes/);
  plugin.dispose();
});

test('refreshes never overlap; triggers during a fetch collapse into one follow-up', async () => {
  const resolvers = [];
  let calls = 0;
  const plugin = await host({}, {
    fetch: () => new Promise((resolve) => {
      calls += 1;
      resolvers.push(() => resolve({ ok: true, text: async () => statusHtml() }));
    }),
  });
  assert.equal(calls, 1, 'the initial refresh is in flight');
  await plugin.tick();
  await plugin.tick();
  assert.equal(calls, 1, 'triggers during the fetch must queue, not start a second fetch');
  resolvers[0]();
  await settle();
  assert.equal(calls, 2, 'exactly one follow-up ran');
  resolvers[1]();
  await settle();
  plugin.dispose();
});

test('an unrelated volatile update neither re-arms nor fetches', async () => {
  const pollIntervalMs = configRef(60000);
  const plugin = await host({ pollIntervalMs });
  const onVolatileUpdate = plugin.handlers.get('loader/volatile-update');
  const fetchesBefore = plugin.fetches.length;
  onVolatileUpdate();
  assert.equal([...plugin.timers][0].delay, 60000);
  assert.equal(plugin.fetches.length, fetchesBefore);
  plugin.dispose();
});

test('changing the status page refreshes immediately', async () => {
  const statusUrl = configRef('https://status.deepseek.com/');
  const plugin = await host({ statusUrl });
  const onVolatileUpdate = plugin.handlers.get('loader/volatile-update');
  const fetchesBefore = plugin.fetches.length;
  statusUrl.value = 'https://status.example.com/';
  onVolatileUpdate();
  await settle();
  assert.equal(plugin.fetches.length, fetchesBefore + 1);
  assert.equal(plugin.fetches.at(-1), 'https://status.example.com/');
  plugin.dispose();
});
