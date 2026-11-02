import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/web/js/main.js', import.meta.url), 'utf8');
const noop = () => {};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

class Element {
  constructor(id) {
    this.id = id;
    this.hidden = true;
    this.open = false;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.classList = { toggle: noop, add: noop, remove: noop };
  }
  addEventListener() {}
  setAttribute() {}
  toggleAttribute() {}
  querySelector() { return new Element(); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  contains() { return false; }
  focus() {}
  close() { this.open = false; }
  showModal() { this.open = true; }
}

async function harness({ storage = async () => true, script = async () => {} } = {}) {
  const state = { client: null, config: null, realtime: null, dashboards: {}, dashboardId: null, data: {}, dataErrors: {} };
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element(id));
    return nodes.get(id);
  };
  const startup = deferred();
  const relays = [];
  const ordering = [];
  const rendered = [];
  const notifications = [];
  const imports = {
    './config.js': { APP_ID: 'test.dashboard', servedByHomey: true, loadConfig: () => startup.promise, writeStoredConfig: storage },
    './dashboard-save.js': { isSaving: () => false, loadKeyScopes: async () => {} },
    './dashboard-editor.js': { initDashboardEditor: noop, syncDashboardEditor: noop },
    './edit-mode.js': { initEditMode: noop, setEditing: noop },
    './embedded.js': { embedded: true, notifyEmbedded: (type) => notifications.push(type) },
    './fit.js': { initFit: noop, isFit: () => false, setFit: noop },
    './dom.js': { $, darkQuery: { addEventListener: noop }, el: () => new Element() },
    './icons.js': { DASHBOARD_ICON: '' },
    './homey-api.js': { createClient: (config) => config.client },
    './highlight.js': { fetchHighlight: async () => {}, isHighlightOpen: () => false, showHighlight: async () => {}, watchHighlight: noop },
    './kiosk.js': { initKiosk: noop, isKiosk: () => false, kioskHome: () => null, resetIdle: noop, screenState: () => 'off', setKiosk: noop, settleKioskHome: noop },
    './pairing.js': { createPairing: () => ({ start: noop, stop: noop }) },
    './realtime.js': {
      loadScript: script,
      createRealtime: (client, callbacks) => {
        ordering.push(`create:${client.id}`);
        const relay = {
          client, callbacks, closed: false, listeners: [],
          on(uri, event, listener) { this.listeners.push({ uri, event, listener }); return noop; },
          close() { this.closed = true; ordering.push(`close:${client.id}`); },
        };
        relays.push(relay);
        return relay;
      },
    },
    './render.js': {
      redrawWidgets: noop, refreshWidgetSizes: noop, updateBoard: noop,
      renderDashboard: async () => { rendered.push({ client: state.client?.id, ids: Object.keys(state.dashboards) }); },
    },
    './screen.js': { adoptScreenId: noop, registerScreen: async () => {}, screenId: () => 'screen', watchScreen: noop },
    './state.js': { STORAGE_KEY: 'test', params: new URLSearchParams(), state },
    './updates.js': { checkForUpdate: async () => {}, watchUpdates: noop },
    './widget-modes.js': { loadWidgetModes: async () => {}, watchWidgetModes: noop },
    './widget-sizes.js': { loadWidgetSizes: async () => {}, watchWidgetSizes: noop },
  };
  const context = vm.createContext({
    console, URLSearchParams,
    document: { addEventListener: noop, querySelectorAll: () => [], body: new Element(), activeElement: null },
    window: { addEventListener: noop },
    localStorage: { getItem: () => null },
    location: { origin: 'https://homey.example', reload: noop },
  });
  // Export accessors only; the production source and its initial boot execute
  // unchanged. The initial configuration promise is deliberately held pending.
  const module = new vm.SourceTextModule(`${source}\nexport { boot, refreshAll, clearConnection };`, { context });
  await module.link((specifier) => {
    assert.ok(imports[specifier], `unexpected dependency ${specifier}`);
    return new vm.SyntheticModule(Object.keys(imports[specifier]), function () {
      for (const [key, value] of Object.entries(imports[specifier])) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return { ...module.namespace, state, nodes, $, startup, relays, ordering, rendered, notifications };
}

function connection(id, custom) {
  const client = {
    id, transport: 'broker', base: 'https://homey.example',
    async api(method, path) {
      const override = custom?.(method, path);
      if (override !== undefined) return override;
      if (path === '/api/manager/system/') return { session: id };
      if (path === '/api/manager/users/user/me') return { id: `${id}-user` };
      if (path === '/api/manager/dashboards/dashboard') return { [id]: { id, name: id, columns: [] } };
      throw new Error(`Unexpected request ${path}`);
    },
  };
  return { homeyUrl: client.base, token: `session-${id}`, transport: 'broker', client };
}

test('a delayed refresh cannot restore dashboards or Edit after Disconnect', async () => {
  const view = await harness();
  const started = deferred();
  const oldDashboards = deferred();
  const old = connection('old', (method, path) => {
    if (path === '/api/manager/dashboards/dashboard') { started.resolve(); return oldDashboards.promise; }
  });
  const boot = view.boot(old);
  await started.promise;
  await view.clearConnection();
  oldDashboards.resolve({ old: { id: 'old', name: 'Old', columns: [] } });
  await boot;

  assert.equal(view.state.client, null);
  assert.deepEqual(structuredClone(view.state.dashboards), {});
  assert.equal(view.$('edit-button').hidden, true);
  assert.equal(view.notifications.includes('connected'), false);
  assert.equal(view.rendered.some(({ ids }) => ids.includes('old')), false);
});

test('a replacement boot closes its old relay before registering new watchers and ignores old responses/events', async () => {
  const view = await harness();
  const started = deferred();
  const oldDashboards = deferred();
  const old = connection('old', (method, path) => {
    if (path === '/api/manager/dashboards/dashboard') { started.resolve(); return oldDashboards.promise; }
  });
  const previous = view.boot(old);
  await started.promise;
  const oldRelay = view.relays[0];
  const next = connection('new');
  await view.boot(next);
  oldDashboards.resolve({ old: { id: 'old', name: 'Old', columns: [] } });
  await previous;
  oldRelay.listeners.find(({ event }) => event === 'dashboard.update').listener({ id: 'old-event', name: 'Old event', columns: [] });
  oldRelay.callbacks.onStatus('offline', 'Stale status');
  oldRelay.callbacks.onReconnect();
  await oldRelay.callbacks.onUnauthorized();

  assert.equal(oldRelay.closed, true);
  assert.deepEqual(view.ordering.slice(0, 3), ['create:old', 'close:old', 'create:new']);
  assert.equal(view.state.client, next.client);
  assert.deepEqual(Object.keys(view.state.dashboards), ['new']);
  assert.equal(view.state.system.session, 'new');
  assert.equal(view.$('edit-button').hidden, false);
  assert.deepEqual(view.notifications, ['connected']);
});

test('an obsolete boot waiting for the socket script cannot create a relay after a newer broker connection', async () => {
  const loaded = deferred();
  const scriptStarted = deferred();
  const view = await harness({ script: () => { scriptStarted.resolve(); return loaded.promise; } });
  const old = connection('old');
  old.client.transport = 'direct';
  const previous = view.boot(old);
  await scriptStarted.promise;
  const next = connection('new');
  await view.boot(next);
  loaded.resolve();
  await previous;

  assert.deepEqual(view.relays.map(({ client }) => client.id), ['new']);
  assert.equal(view.state.client, next.client);
  assert.deepEqual(Object.keys(view.state.dashboards), ['new']);
});

test('initial stored configuration arriving after a new connection cannot replace it', async () => {
  const view = await harness();
  const next = connection('new');
  await view.boot(next);
  view.startup.resolve(connection('legacy'));
  await new Promise(setImmediate);

  assert.equal(view.state.client, next.client);
  assert.deepEqual(view.relays.map(({ client }) => client.id), ['new']);
  assert.deepEqual(Object.keys(view.state.dashboards), ['new']);
});

test('a slow disconnect cannot clear a newly established connection when storage finishes', async () => {
  const stored = deferred();
  const view = await harness({ storage: () => stored.promise });
  await view.boot(connection('old'));
  const clearing = view.clearConnection();
  const next = connection('new');
  await view.boot(next);
  stored.resolve(true);

  assert.equal(await clearing, false, 'the superseded disconnect must not reopen setup');
  assert.equal(view.state.client, next.client);
  assert.equal(view.state.config.token, next.token);
  assert.deepEqual(Object.keys(view.state.dashboards), ['new']);
  assert.equal(view.$('edit-button').hidden, false);
});
