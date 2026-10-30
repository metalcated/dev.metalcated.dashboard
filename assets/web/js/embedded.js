// Only the immediate Homey settings frame may provide an embedded connection.
// Credentials remain in memory and are never accepted through an address/query.
export const embedded = new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window;
let parentOrigin = null;
try {
  const referrer = new URL(document.referrer);
  if (['http:', 'https:'].includes(referrer.protocol)) parentOrigin = referrer.origin;
} catch {
  // Without a verifiable parent, embedding fails closed rather than accepting any sender.
}
// Homey's local settings view can suppress Referrer entirely. In that case,
// reading the immediate parent's location is itself a same-origin browser check.
// Accept only this app's settings document, never another app or a claimed URL
// supplied through a message.
if (embedded && !parentOrigin && !document.referrer) {
  try {
    const app = /^\/app\/([^/]+)\/assets\/web\/index\.html$/.exec(location.pathname);
    const parent = new URL(window.parent.location.href);
    const settings = app && `/app/${app[1]}/settings`;
    if (settings && ['http:', 'https:'].includes(parent.protocol)
      && parent.origin === location.origin && !parent.username && !parent.password
      && [settings, `${settings}/`, `${settings}/index.html`].includes(parent.pathname)) {
      parentOrigin = parent.origin;
    }
  } catch {
    // Cross-origin parent access throws. Keep the connection closed.
  }
}

let config = null;
let pending = null;
let parentVisible = true;
const visibilityListeners = new Set();

export function notifyEmbedded(type, details = {}) {
  if (embedded && parentOrigin) window.parent.postMessage({ ...details, type: `dashboard:${type}` }, parentOrigin);
}

export const isDashboardVisible = () => document.visibilityState !== 'hidden' && (!embedded || parentVisible);

function announceVisibility() {
  for (const listener of visibilityListeners) listener(isDashboardVisible());
}

export function subscribeDashboardVisibility(listener) {
  visibilityListeners.add(listener);
  return () => visibilityListeners.delete(listener);
}

document.addEventListener('visibilitychange', announceVisibility);

if (embedded) window.addEventListener('message', (event) => {
  if (!parentOrigin || event.source !== window.parent || event.origin !== parentOrigin) return;
  if (event.data?.type === 'dashboard:visibility' && typeof event.data.visible === 'boolean') {
    parentVisible = event.data.visible;
    announceVisibility();
    return;
  }
  if (event.data?.type !== 'dashboard:connect') return;
  const candidate = event.data.config;
  if (candidate?.transport !== 'broker' || typeof candidate.token !== 'string' || !candidate.token) return;
  try {
    const address = new URL(candidate.homeyUrl);
    if (!['http:', 'https:'].includes(address.protocol) || address.origin !== location.origin
      || address.username || address.password) return;
    config = { homeyUrl: address.origin, token: candidate.token, transport: 'broker', screenId: candidate.screenId };
    pending?.resolve(config);
  } catch {
    // Malformed connection messages do not change the active session.
  }
});

export function waitForEmbeddedConfig({ timeout = 15000 } = {}) {
  if (!embedded) return Promise.resolve(null);
  if (!parentOrigin) return Promise.reject(new Error('Open this dashboard from its Homey app view.'));
  if (config) return Promise.resolve(config);
  if (pending) return pending.promise;
  let timer;
  const promise = new Promise((resolve, reject) => {
    pending = {
      resolve(value) { clearTimeout(timer); pending = null; resolve(value); },
      promise: null,
    };
    timer = setTimeout(() => {
      pending = null;
      const error = new Error('Homey did not finish connecting. Use Retry in the Homey dashboard view.');
      notifyEmbedded('error', { message: error.message });
      reject(error);
    }, timeout);
  });
  pending.promise = promise;
  notifyEmbedded('ready');
  return promise;
}
