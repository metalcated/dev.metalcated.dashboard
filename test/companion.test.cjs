'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ORIGIN = 'http://192.168.1.20:4859';
const HOMEY = '6add33dde406853bfda0bd09';
const PREFIX = `/web/homeys/${HOMEY}`;
const NAV_ID = 'metalcated-dashboard-companion-nav';
const PANEL_ID = 'metalcated-dashboard-companion-panel';
const FRAME_ID = 'metalcated-dashboard-companion-frame';

// The fixture models the observed Homey main navigation, including its narrow
// nav inside a wider container. No network, credentials, browser storage, or
// application globals are available to the content script under test.
function browser({ url = `${ORIGIN}${PREFIX}/devices`, navigation = true } = {}) {
  let document;
  let nextTimer = 1;
  const frames = new Map();
  const intervals = new Map();
  const observers = [];
  const posted = [];
  const forbidden = [];
  const focused = [];

  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ callback, capture: options === true || options?.capture === true, once: options?.once === true });
    }
    removeEventListener(type, callback) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry.callback !== callback));
    }
    emit(type, details = {}) {
      const event = { type, target: this, defaultPrevented: false, button: 0,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...details };
      for (const { callback, once } of [...(this.listeners.get(type) ?? [])]) {
        callback(event);
        if (once) this.removeEventListener(type, callback);
      }
      return event;
    }
  }

  const simpleMatch = (node, selector) => {
    if (!(node instanceof Element)) return false;
    const value = selector.trim();
    if (value === '*') return true;
    const tag = /^[a-zA-Z][\w-]*/.exec(value)?.[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    const id = /#([\w-]+)/.exec(value)?.[1];
    if (id && node.id !== id) return false;
    for (const match of value.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(match[1])) return false;
    for (const match of value.matchAll(/\[([^\]=~^$*\s]+)(?:([~^$*]?=)["']?([^\]"']*)["']?)?\]/g)) {
      const actual = node.getAttribute(match[1]);
      if (actual === null) return false;
      if (match[2] === '=' && actual !== match[3]) return false;
      if (match[2] === '^=' && !actual.startsWith(match[3])) return false;
      if (match[2] === '$=' && !actual.endsWith(match[3])) return false;
      if (match[2] === '*=' && !actual.includes(match[3])) return false;
    }
    return true;
  };
  const matches = (node, selector) => selector.split(',').some((part) => {
    const components = part.trim().match(/(?:\[[^\]]*\]|[^\s])+/g) ?? [];
    if (!simpleMatch(node, components.pop())) return false;
    let ancestor = node.parentElement;
    while (components.length) {
      const component = components.pop();
      while (ancestor && !simpleMatch(ancestor, component)) ancestor = ancestor.parentElement;
      if (!ancestor) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  });

  class Element extends Target {
    constructor(tag = 'div') {
      super();
      this.tagName = tag.toUpperCase();
      this.nodeType = 1;
      this.children = [];
      this.attributes = new Map();
      this.parentElement = null;
      this.hidden = false;
      this.style = { setProperty(name, value) { this[name] = String(value); }, removeProperty(name) { delete this[name]; }, getPropertyValue(name) { return this[name] ?? ''; } };
      this.dataset = {};
      this._text = '';
      if (tag === 'iframe') this.contentWindow = { postMessage(message, origin) { posted.push({ message, origin }); } };
      this.classList = {
        contains: (value) => this.className.split(/\s+/).includes(value),
        add: (...values) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...values])].join(' '); },
        remove: (...values) => { this.className = this.className.split(/\s+/).filter((value) => !values.includes(value)).join(' '); },
        toggle: (value, force) => {
          const add = force ?? !this.classList.contains(value);
          if (add) this.classList.add(value); else this.classList.remove(value);
          return add;
        },
      };
    }
    get id() { return this.getAttribute('id') ?? ''; }
    set id(value) { this.setAttribute('id', value); }
    get inert() { return this.hasAttribute('inert'); }
    set inert(value) { if (value) this.setAttribute('inert', ''); else this.removeAttribute('inert'); }
    get className() { return this.getAttribute('class') ?? ''; }
    set className(value) { this.setAttribute('class', value); }
    get href() { return new URL(this.getAttribute('href') ?? '', window.location.href).href; }
    set href(value) { this.setAttribute('href', value); }
    get src() { return this.getAttribute('src') ?? ''; }
    set src(value) { this.setAttribute('src', value); }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get childNodes() { return this.children; }
    get parentNode() { return this.parentElement; }
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
    get nextElementSibling() { return this.nextSibling; }
    get isConnected() { return this === document.documentElement || Boolean(this.parentElement?.isConnected); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    getAttributeNames() { return [...this.attributes.keys()]; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) {
      for (const node of nodes) {
        node.remove(); node.parentElement = this; this.children.push(node);
      }
    }
    appendChild(node) { this.append(node); return node; }
    insertBefore(node, reference) {
      if (!reference) return this.appendChild(node);
      node.remove(); node.parentElement = this;
      this.children.splice(this.children.indexOf(reference), 0, node);
      return node;
    }
    after(node) { this.parentElement.insertBefore(node, this.nextSibling); }
    prepend(node) { this.insertBefore(node, this.children[0]); }
    remove() {
      if (!this.parentElement) return;
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1); this.parentElement = null;
    }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    matches(selector) { return matches(this, selector); }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node; return null; }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    cloneNode(deep) {
      const copy = new Element(this.tagName.toLowerCase());
      copy.attributes = new Map(this.attributes); copy._text = this._text;
      if (deep) copy.append(...this.children.map((child) => child.cloneNode(true)));
      return copy;
    }
    getBoundingClientRect() { return this.rect ?? { left: 16, right: 88, top: 104, bottom: 1057, width: 72, height: 953 }; }
    focus() {
      const blocked = Boolean(this.closest('[inert]'));
      focused.push({ node: this, blocked });
      if (!blocked) document.activeElement = this;
    }
    click(details = {}) {
      const event = { type: 'click', target: this, defaultPrevented: false, button: 0,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...details };
      for (const { callback, capture } of document.listeners.get('click') ?? []) if (capture) callback(event);
      for (let node = this; node; node = node.parentElement) for (const { callback } of node.listeners.get('click') ?? []) callback(event);
      for (const { callback, capture } of document.listeners.get('click') ?? []) if (!capture) callback(event);
      return event;
    }
  }

  document = new Target();
  document.documentElement = new Element('html');
  document.body = new Element('body');
  document.head = new Element('head');
  document.documentElement.append(document.head, document.body);
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_, tag) => new Element(tag);
  document.querySelectorAll = (selector) => document.documentElement.querySelectorAll(selector);
  document.querySelector = (selector) => document.querySelectorAll(selector)[0] ?? null;
  document.getElementById = (id) => document.querySelector(`#${id}`);
  document.visibilityState = 'visible';
  document.readyState = 'complete';
  document.activeElement = document.body;
  const window = new Target();
  window.location = new URL(url);
  window.innerWidth = 1440;
  window.innerHeight = 1080;
  window.document = document;
  window.top = window;
  window.history = { pushState() {}, replaceState() {} };

  const denied = (owner, name) => Object.defineProperty(owner, name, { get() {
    forbidden.push(name); throw new Error(`The companion must not access ${name}.`);
  } });
  for (const key of ['localStorage', 'sessionStorage', 'fetch', 'Homey']) denied(window, key);
  denied(document, 'cookie');
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.target = null; }
  }
  class ResizeObserver { observe() {} disconnect() {} }
  const requestAnimationFrame = (callback) => { const id = nextTimer++; frames.set(id, callback); return id; };
  Object.assign(window, { MutationObserver, ResizeObserver, requestAnimationFrame, cancelAnimationFrame: (id) => frames.delete(id) });
  const context = { window, document, location: window.location, history: window.history, URL, URLSearchParams, console,
    Element, HTMLElement: Element, Node: { ELEMENT_NODE: 1 }, MutationObserver, ResizeObserver,
    requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame,
    setInterval(callback) { const id = nextTimer++; intervals.set(id, callback); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout: requestAnimationFrame, clearTimeout: window.cancelAnimationFrame,
    getComputedStyle: () => ({ getPropertyValue: () => '', color: 'rgb(22, 22, 22)', backgroundColor: 'rgb(250, 250, 250)' }),
    HOMEY_DASHBOARD_COMPANION: { origin: ORIGIN, homeyId: HOMEY, appId: 'dev.schweiger.dashboard' },
  };
  window.setInterval = context.setInterval;
  window.clearInterval = context.clearInterval;
  window.getComputedStyle = context.getComputedStyle;
  for (const key of ['localStorage', 'sessionStorage', 'fetch', 'Homey', 'indexedDB']) denied(context, key);
  const container = new Element();
  container.className = 'MainNav-container-040f2';
  container.rect = { left: 16, right: 368, width: 352 };
  container.style.zIndex = '200';
  const layout = new Element();
  const navRoot = new Element(); navRoot.className = 'MainNav-root-540d8';
  const logo = new Element(); logo.className = 'MainNav-logoWrapper-c6716';
  const logoLink = new Element('a'); logoLink.href = '/web/homeys'; logo.append(logoLink);
  let secondaryHeader = new Element('header'); secondaryHeader.className = 'MainNav-header-77f48';
  let secondarySidebar = new Element(); secondarySidebar.className = 'MainNav-subNavWrapper-98759';
  container.append(logo, secondaryHeader, secondarySidebar);
  navRoot.append(container);
  const makeMain = () => {
    const main = new Element('main'); main.style.zIndex = '100';
    const header = new Element('header'); header.style.zIndex = '400';
    const control = new Element('button'); control.textContent = 'Native device';
    main.append(header, control);
    return main;
  };
  let main = makeMain();
  layout.append(navRoot, main);
  document.body.append(layout);
  const makeNav = () => {
    const nav = new Element('nav');
    nav.className = 'MainNav-navLinkItems-59ad8';
    for (const [name, route] of [['Home', ''], ['Devices', '/devices'], ['Flows', '/flows'], ['Insights', '/insights'], ['HomeyScript', '/scripts'], ['Settings', '/settings']]) {
      const link = new Element('a');
      link.className = 'MainNavItem-root-1ce3e';
      link.href = `${PREFIX}${route}`;
      link.setAttribute('aria-label', name);
      link.setAttribute('data-is-active', String(name === 'Devices'));
      link.setAttribute('data-is-focus-visible', 'false');
      link.setAttribute('data-react-aria-pressable', 'true');
      const icon = new Element('span'); icon.className = 'MainNavItem-iconWrapper-c1256';
      const glyph = new Element('span'); glyph.className = 'Glyph-root-57c3f MainNavItem-moduleGlyph-5839f'; icon.append(glyph);
      const label = new Element('span'); label.className = 'MainNavItem-label-0c6d6'; label.textContent = name;
      link.append(icon, label); nav.append(link);
    }
    container.insertBefore(nav, secondaryHeader);
    return nav;
  };
  let nav = navigation ? makeNav() : null;
  vm.createContext(context);
  return {
    document, window, context, posted, forbidden, focused, Element, container, navRoot, logo, logoLink,
    node: (id) => document.getElementById(id),
    get nav() { return nav; },
    get main() { return main; },
    get secondaryHeader() { return secondaryHeader; },
    get secondarySidebar() { return secondarySidebar; },
    native: (name) => nav?.querySelector(`[aria-label="${name}"]`),
    settle() {
      for (let count = 0; frames.size; count++) {
        assert.ok(count < 20, 'content script must settle without a mutation loop');
        const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback();
      }
    },
    notify(records = [{ type: 'childList', target: container, addedNodes: [], removedNodes: [] }]) {
      for (const observer of observers) if (observer.target) observer.callback(records);
      this.settle();
    },
    replaceNavigation() { nav?.remove(); nav = makeNav(); this.notify([{ type: 'childList', target: container, addedNodes: [nav], removedNodes: [] }]); },
    replaceMain() {
      const old = main; main = makeMain(); layout.insertBefore(main, old); old.remove();
      this.notify([{ type: 'childList', target: layout, addedNodes: [main], removedNodes: [old] }]);
      return old;
    },
    replaceSecondary() {
      const old = [secondaryHeader, secondarySidebar];
      secondaryHeader = new Element('header'); secondaryHeader.className = 'MainNav-header-77f48';
      secondarySidebar = new Element(); secondarySidebar.className = 'MainNav-subNavWrapper-98759';
      container.append(secondaryHeader, secondarySidebar); for (const node of old) node.remove();
      this.notify([{ type: 'childList', target: container, addedNodes: [secondaryHeader, secondarySidebar], removedNodes: old }]);
      return old;
    },
    navigate(next) { window.location.href = new URL(next, window.location.href).href; for (const callback of intervals.values()) callback(); this.settle(); },
    load() {
      const source = fs.readFileSync(path.join(__dirname, '../companion/content.js'), 'utf8');
      vm.runInContext(source, context, { filename: 'companion/content.js' }); this.settle();
    },
  };
}

test('companion is scoped to the configured Homey origin and exact Homey path', () => {
  for (const url of [`https://my.homey.app${PREFIX}/devices`, `${ORIGIN}/web/homeys/another-homey/devices`, `${ORIGIN}/web/homeys/${HOMEY}-suffix/devices`, `${ORIGIN}/app/dev.schweiger.dashboard/settings`]) {
    const host = browser({ url });
    host.load();
    assert.equal(host.node(NAV_ID), null, `no navigation entry on ${url}`);
    assert.equal(host.node(PANEL_ID), null);
    assert.deepEqual(host.forbidden, []);
  }
});

test('invalid configuration and nested frames cannot add a navigation entry', () => {
  for (const changes of [
    { origin: 'javascript:alert(1)' }, { origin: `${ORIGIN}/` }, { origin: 'http://user:secret@192.168.1.20:4859' },
    { homeyId: `${HOMEY}/devices` }, { appId: '../other-app' },
  ]) {
    const host = browser();
    Object.assign(host.context.HOMEY_DASHBOARD_COMPANION, changes);
    host.load();
    assert.equal(host.node(NAV_ID), null);
    assert.equal(host.node(PANEL_ID), null);
    assert.deepEqual(host.forbidden, []);
  }
  const nested = browser();
  nested.window.top = {};
  nested.load();
  assert.equal(nested.node(NAV_ID), null);
});

test('an unknown Homey layout is left alone until the real main navigation appears', () => {
  const host = browser({ navigation: false });
  const original = [...host.container.children];
  host.load();
  assert.equal(host.node(NAV_ID), null);
  assert.equal(host.node(PANEL_ID), null);
  assert.deepEqual(host.container.children, original);
  host.replaceNavigation();
  assert.ok(host.node(NAV_ID));
  assert.equal(host.document.querySelectorAll(`#${NAV_ID}`).length, 1);
  assert.deepEqual(host.forbidden, []);
});

test('primary entry click opens one same-origin dashboard beside the narrow main rail', () => {
  const host = browser();
  host.load();
  const link = host.node(NAV_ID);
  assert.ok(link);
  assert.equal(host.native('Home').nextElementSibling, link);
  const standalone = new URL(link.href);
  assert.equal(standalone.origin, ORIGIN);
  assert.equal(standalone.pathname, '/app/dev.schweiger.dashboard/assets/web/index.html');
  assert.equal(standalone.search, '');
  assert.equal(standalone.hash, '');

  assert.equal(link.click().defaultPrevented, true);
  host.settle();
  const frame = host.node(FRAME_ID);
  const panel = host.node(PANEL_ID);
  assert.ok(frame);
  assert.equal(panel.hidden, false);
  assert.equal(panel.style.getPropertyValue('--mdc-left'), '104px', 'use nav.right + 16, not the settings container right edge');
  const address = new URL(frame.src);
  assert.equal(address.origin, ORIGIN);
  assert.equal(address.pathname, standalone.pathname);
  assert.equal(address.searchParams.get('shell'), '1');
  assert.equal(address.searchParams.has('embedded'), false);
  assert.equal(address.searchParams.has('token'), false);
  assert.equal(address.hash, '');
  assert.equal(host.window.location.pathname, `${PREFIX}/devices`);
  link.click(); host.settle();
  assert.equal(host.document.querySelectorAll(`#${FRAME_ID}`).length, 1);
  assert.deepEqual(host.forbidden, []);
});

test('modified and middle clicks retain the clean standalone address and native browser behavior', () => {
  const host = browser();
  host.load();
  const link = host.node(NAV_ID);
  for (const details of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal(link.click(details).defaultPrevented, false);
    assert.ok(!host.node(PANEL_ID) || host.node(PANEL_ID).hidden);
  }
  assert.equal(new URL(link.href).search, '');
  assert.deepEqual(host.forbidden, []);
});

test('the panel paints above both native layers and its own rail label stays on one line', () => {
  const host = browser();
  host.load(); host.node(NAV_ID).click(); host.settle();
  const css = fs.readFileSync(path.join(__dirname, '../companion/content.css'), 'utf8');
  const panelRules = /\.mdc-panel\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  const zIndex = Number(/z-index:\s*(\d+)/.exec(panelRules)?.[1]);
  assert.ok(zIndex > Number(host.main.style.zIndex), 'the nested native header stays inside MAIN z100');
  assert.ok(zIndex > Number(host.container.style.zIndex), 'the secondary sidebar shares the navigation z200');
  assert.ok(host.node(NAV_ID).querySelector('.mdc-nav-label'));
  assert.match(css, /\.mdc-nav-entry\s+\.mdc-nav-label\s*\{[^}]*white-space:\s*nowrap;/);
  assert.equal(host.node(PANEL_ID).style.getPropertyValue('--mdc-left'), '104px', 'the higher panel still leaves the primary rail accessible');
});

test('covered content is inert while open and exact prior inert state is restored before native focus', () => {
  const host = browser();
  host.secondaryHeader.setAttribute('inert', 'native-header-state');
  host.secondarySidebar.inert = true;
  const control = host.main.children[1]; control.focus();
  host.load(); host.node(NAV_ID).click(); host.settle();
  for (const node of [host.main, host.secondaryHeader, host.secondarySidebar]) assert.equal(node.inert, true);
  for (const node of [host.nav, host.logo, host.container, host.navRoot]) assert.equal(node.inert, false, 'the primary rail, logo and their ancestors stay usable');
  const back = host.document.activeElement;
  control.focus();
  assert.equal(host.document.activeElement, back, 'keyboard focus cannot move to a covered native device');
  assert.equal(host.focused.at(-1).blocked, true);
  host.document.emit('keydown', { key: 'Escape' });
  assert.equal(host.main.inert, false);
  assert.equal(host.main.getAttribute('inert'), null);
  assert.equal(host.secondaryHeader.getAttribute('inert'), 'native-header-state');
  assert.equal(host.secondarySidebar.getAttribute('inert'), '');
  assert.equal(host.document.activeElement, control);
  assert.equal(host.focused.at(-1).blocked, false, 'restoration must precede the focus call');
  assert.deepEqual(host.forbidden, []);
});

test('replacement main and secondary sidebar at the same route inherit isolation without disabling the rail', () => {
  const host = browser();
  host.secondaryHeader.setAttribute('inert', 'preexisting');
  host.load(); host.node(NAV_ID).click(); host.settle();
  const oldMain = host.replaceMain();
  const oldSecondary = host.replaceSecondary();
  assert.equal(host.node(PANEL_ID).hidden, false);
  assert.equal(oldMain.inert, false, 'detached content returns to its original state');
  assert.equal(oldSecondary[0].getAttribute('inert'), 'preexisting');
  assert.equal(oldSecondary[1].inert, false);
  for (const node of [host.main, host.secondaryHeader, host.secondarySidebar]) assert.equal(node.inert, true);
  assert.equal(host.nav.inert, false); assert.equal(host.logo.inert, false);
  assert.equal(host.native('Flows').click().defaultPrevented, false);
  for (const node of [host.main, host.secondaryHeader, host.secondarySidebar]) assert.equal(node.inert, false);
  assert.equal(host.node(PANEL_ID).hidden, true);
  assert.deepEqual(host.forbidden, []);
});

test('every route and page-cache teardown restores covered controls, including previously inert content', () => {
  for (const teardown of [
    (host) => host.navigate(`${PREFIX}/flows`),
    (host) => host.navigate('/web/homeys/another-homey/devices'),
    (host) => host.replaceNavigation(),
    (host) => host.window.emit('popstate'),
    (host) => host.window.emit('pagehide', { persisted: true }),
  ]) {
    const host = browser();
    host.secondarySidebar.setAttribute('inert', 'retained-native-state');
    host.load(); host.node(NAV_ID).click(); host.settle();
    teardown(host); host.settle();
    assert.equal(host.main.inert, false);
    assert.equal(host.secondaryHeader.inert, false);
    assert.equal(host.secondarySidebar.getAttribute('inert'), 'retained-native-state');
    assert.equal(host.nav.inert, false); assert.equal(host.logo.inert, false);
    assert.deepEqual(host.forbidden, []);
  }
});

test('unfamiliar layout boundaries keep the standalone link and never disable native controls', () => {
  for (const change of [
    (host) => { host.navRoot.className = 'ChangedVendorContainer'; },
    (host) => host.logo.remove(),
    (host) => host.container.append(new host.Element()),
    (host) => host.main.remove(),
  ]) {
    const host = browser(); host.load(); change(host);
    assert.equal(host.node(NAV_ID).click().defaultPrevented, false);
    assert.equal(host.node(PANEL_ID), null);
    for (const node of [host.main, host.secondaryHeader, host.secondarySidebar, host.nav, host.logo, host.container, host.navRoot]) assert.equal(node.inert, false);
    assert.deepEqual(host.forbidden, []);
  }
});

test('an unfamiliar replacement while open retires the overlay and restores the vendor interface', () => {
  const host = browser(); host.load(); host.node(NAV_ID).click(); host.settle();
  const unknown = new host.Element(); host.container.append(unknown);
  host.notify([{ type: 'childList', target: host.container, addedNodes: [unknown], removedNodes: [] }]);
  assert.equal(host.node(PANEL_ID).hidden, true);
  for (const node of [host.main, host.secondaryHeader, host.secondarySidebar, host.nav, host.logo, unknown]) assert.equal(node.inert, false);
  assert.deepEqual(host.forbidden, []);
});

test('choosing another native navigation entry closes the dashboard without swallowing the click', () => {
  const host = browser();
  host.load();
  const devices = host.native('Devices');
  host.node(NAV_ID).click(); host.settle();
  const event = host.native('Flows').children[0].click();
  host.settle();
  assert.equal(event.defaultPrevented, false);
  assert.equal(host.node(PANEL_ID).hidden, true);
  assert.equal(devices.getAttribute('data-is-active'), 'true', 'restore the native selection changed by the shell');
  assert.equal(host.node(NAV_ID).getAttribute('data-is-active'), 'false');
  assert.deepEqual(host.forbidden, []);
});

test('SPA navigation rerenders do not duplicate the entry and switching Homey removes the panel', () => {
  const host = browser();
  host.load();
  host.node(NAV_ID).click(); host.settle();
  host.replaceNavigation();
  assert.equal(host.document.querySelectorAll(`#${NAV_ID}`).length, 1);
  assert.equal(host.nav.contains(host.node(NAV_ID)), true);
  assert.equal(host.node(PANEL_ID), null, 'a replaced vendor rail retires its old renderer');
  host.notify(); host.notify();
  assert.equal(host.document.querySelectorAll(`#${NAV_ID}`).length, 1);
  host.node(NAV_ID).click(); host.settle();
  host.native('Flows').click(); host.settle();
  assert.equal(host.node(PANEL_ID).hidden, true);
  host.node(NAV_ID).click(); host.settle();
  host.navigate(`${PREFIX}/insights`);
  assert.equal(host.node(PANEL_ID).hidden, true);
  host.node(NAV_ID).click(); host.settle();
  host.navigate('/web/homeys/another-homey/devices');
  assert.equal(host.node(NAV_ID), null);
  assert.equal(host.node(PANEL_ID), null);
  assert.deepEqual(host.forbidden, []);
});

test('back and Escape restore focus and native selection after a simple close', () => {
  const host = browser();
  host.load();
  const devices = host.native('Devices');
  devices.setAttribute('aria-current', 'page');
  devices.focus();
  host.node(NAV_ID).click(); host.settle();
  const back = host.node(PANEL_ID).querySelector('[aria-label="Back to Homey"]');
  assert.equal(host.document.activeElement, back);
  assert.equal(devices.getAttribute('data-is-active'), 'false');
  assert.equal(devices.hasAttribute('aria-current'), false);
  back.click(); host.settle();
  assert.equal(host.document.activeElement, devices);
  assert.equal(devices.getAttribute('data-is-active'), 'true');
  assert.equal(devices.getAttribute('aria-current'), 'page');

  host.node(NAV_ID).focus();
  host.node(NAV_ID).click(); host.settle();
  host.document.emit('keydown', { key: 'Escape' });
  assert.equal(host.node(PANEL_ID).hidden, true);
  assert.equal(host.document.activeElement, host.node(NAV_ID));
  assert.deepEqual(host.forbidden, []);
});

test('a changed native route remains authoritative instead of restoring an obsolete active entry', () => {
  const host = browser();
  host.load();
  host.node(NAV_ID).click(); host.settle();
  host.native('Flows').setAttribute('data-is-active', 'true');
  host.navigate(`${PREFIX}/flows`);
  assert.equal(host.node(PANEL_ID).hidden, true);
  assert.equal(host.native('Flows').getAttribute('data-is-active'), 'true');
  assert.equal(host.native('Devices').getAttribute('data-is-active'), 'false');
  assert.deepEqual(host.forbidden, []);
});

test('renderer visibility is passive, exact-origin and follows open, load, document hide and close', () => {
  const host = browser();
  host.load();
  host.node(NAV_ID).click(); host.settle();
  const frame = host.node(FRAME_ID);
  frame.emit('load');
  assert.equal(host.posted.at(-1).message.visible, true);
  host.document.visibilityState = 'hidden';
  host.document.emit('visibilitychange');
  assert.equal(host.posted.at(-1).message.visible, false);
  host.document.visibilityState = 'visible';
  host.document.emit('visibilitychange');
  assert.equal(host.posted.at(-1).message.visible, true);
  host.node(PANEL_ID).querySelector('.mdc-back').click();
  assert.equal(host.posted.at(-1).message.visible, false);
  for (const { message, origin } of host.posted) {
    assert.equal(origin, ORIGIN);
    assert.equal(message.type, 'dashboard:visibility');
    assert.deepEqual(Object.keys(message).sort(), ['type', 'visible']);
  }
  assert.deepEqual(host.forbidden, []);
});

test('missing labels or foreign navigation never become an integration target', () => {
  for (const change of [
    (host) => host.native('Devices').querySelector('[class*="MainNavItem-label"]').remove(),
    (host) => { host.native('Devices').href = 'https://other.example/web/homeys/6add33dde406853bfda0bd09/devices'; },
    (host) => {
      const devices = host.native('Devices');
      const wrapper = new host.Element(); devices.remove(); wrapper.append(devices); host.nav.append(wrapper);
    },
  ]) {
    const host = browser();
    // Missing expected label is checked on the cloned Home entry, if present.
    host.native('Home').remove();
    change(host);
    const children = [...host.nav.children];
    host.load();
    assert.equal(host.node(NAV_ID), null);
    assert.equal(host.node(PANEL_ID), null);
    assert.deepEqual(host.nav.children, children);
    assert.deepEqual(host.forbidden, []);
  }
});

test('without a Home anchor the entry appears immediately before Devices', () => {
  const host = browser();
  host.native('Home').remove();
  host.load();
  assert.equal(host.node(NAV_ID).nextElementSibling, host.native('Devices'));
  assert.equal(host.node(NAV_ID).getAttribute('aria-label'), 'Dashboards');
  assert.equal(host.node(NAV_ID).textContent, 'Dashboards');
  assert.deepEqual(host.forbidden, []);
});

test('duplicate execution stays single and page exit disconnects the integration', () => {
  const host = browser();
  host.load(); host.load();
  assert.equal(host.document.querySelectorAll(`#${NAV_ID}`).length, 1);
  host.node(NAV_ID).click(); host.settle();
  assert.equal(host.document.querySelectorAll(`#${FRAME_ID}`).length, 1);
  host.window.emit('pagehide'); host.settle();
  assert.equal(host.node(NAV_ID), null);
  assert.equal(host.node(PANEL_ID), null);
  host.replaceNavigation();
  host.navigate(`${PREFIX}/flows`);
  assert.equal(host.node(NAV_ID), null, 'retired content script must not remount');
  assert.deepEqual(host.forbidden, []);
});

test('Back/Forward and hash navigation close the panel without altering vendor history methods', () => {
  const host = browser();
  const pushState = host.window.history.pushState;
  const replaceState = host.window.history.replaceState;
  host.load();
  for (const event of ['popstate', 'hashchange']) {
    host.node(NAV_ID).click(); host.settle();
    host.window.emit(event); host.settle();
    assert.equal(host.node(PANEL_ID).hidden, true);
    assert.equal(host.native('Devices').getAttribute('data-is-active'), 'true');
  }
  assert.equal(host.window.history.pushState, pushState);
  assert.equal(host.window.history.replaceState, replaceState);
  assert.deepEqual(host.forbidden, []);
});

test('Connection opens settings separately while retaining the waiting pairing renderer', () => {
  const host = browser();
  host.load();
  host.node(NAV_ID).click(); host.settle();
  const frame = host.node(FRAME_ID);
  const address = frame.src;
  const connection = host.node(PANEL_ID).querySelectorAll('a[href]').find((anchor) => anchor.textContent === 'Connection');
  assert.ok(connection);
  assert.equal(new URL(connection.href).pathname, `${PREFIX}/settings/apps/dev.schweiger.dashboard`);
  assert.equal(connection.target, '_blank');
  assert.match(connection.rel, /\bnoopener\b/);
  assert.match(connection.rel, /\bnoreferrer\b/);
  assert.equal(connection.click().defaultPrevented, false);
  host.settle();
  assert.equal(host.node(PANEL_ID).hidden, false, 'pairing polling must remain visible while approval opens in another tab');
  assert.equal(host.node(FRAME_ID) === frame, true);
  assert.equal(frame.src, address);
  assert.deepEqual(host.forbidden, []);
});

test('two page-cache restores reattach one entry, resume route watching and clean up every exit', () => {
  const host = browser();
  host.load();
  for (let cycle = 0; cycle < 2; cycle++) {
    host.node(NAV_ID).click(); host.settle();
    host.window.emit('pagehide', { persisted: true });
    host.settle();
    assert.equal(host.node(NAV_ID), null);
    assert.equal(host.node(PANEL_ID), null);
    host.window.emit('pageshow', { persisted: true });
    host.settle();
    assert.equal(host.document.querySelectorAll(`#${NAV_ID}`).length, 1);
    host.node(NAV_ID).click(); host.settle();
    host.navigate(`${PREFIX}/flows?cycle=${cycle}`);
    assert.equal(host.node(PANEL_ID).hidden, true, 'route polling resumes after cache restore');
  }
  assert.deepEqual(host.forbidden, []);
});

test('cloning the native appearance discards inline event handlers and duplicate descendant IDs', () => {
  const host = browser();
  const home = host.native('Home');
  home.setAttribute('onclick', 'readCredentials()');
  home.setAttribute('onfocus', 'readCredentials()');
  home.children[0].id = 'native-home-icon';
  home.children[1].setAttribute('onmouseover', 'readCredentials()');
  host.load();
  const entry = host.node(NAV_ID);
  assert.ok(entry);
  for (const node of [entry, ...entry.querySelectorAll('*')]) {
    assert.equal(node.getAttributeNames().some((name) => /^on/i.test(name)), false);
    if (node !== entry) assert.equal(node.hasAttribute('id'), false);
  }
  assert.equal(home.getAttribute('onclick'), 'readCredentials()', 'vendor nodes remain unchanged');
  assert.equal(home.children[0].id, 'native-home-icon');
  assert.deepEqual(host.forbidden, []);
});

