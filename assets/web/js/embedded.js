// Only the immediate Homey settings frame may provide an embedded connection.
// Credentials remain in memory and are never accepted through an address/query.
export const embedded = new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window;
// The desktop companion hosts the normal paired renderer. Its only extra authority is pausing an off-screen view;
// authentication and configuration still use the standalone browser's own connection database.
export const hosted = !embedded && new URLSearchParams(location.search).get('shell') === '1' && window.parent !== window;
const fragment = new URLSearchParams((location.hash ?? '').slice(1));
const nonce = fragment.get('bridge');
const bridgeRequested = embedded && fragment.has('bridge');
const validNonce = fragment.getAll('bridge').length === 1 && /^[a-f0-9]{32}$/.test(nonce ?? '');
const channelMode = bridgeRequested && validNonce && typeof MessageChannel === 'function';
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
let parentVisible = !hosted;
const visibilityListeners = new Set();
const requests = new Map();
let requestSequence = 0;
let port = null;
let channelFailure = null;

export const usesEmbeddedBroker = () => channelMode;

function channelError(message, status = 503) {
  return Object.assign(new Error(message), { status });
}

function failChannel(error) {
  channelFailure = error;
  pending?.reject(error);
  for (const request of [...requests.values()]) request.reject(error);
  port?.close();
}

export function notifyEmbedded(type, details = {}) {
  const message = { ...details, type: `dashboard:${type}` };
  if (channelMode) {
    if (port && !channelFailure) {
      try { port.postMessage(message); } catch { failChannel(channelError('The Homey dashboard connection closed. Reload to reconnect.')); }
    }
  } else if (!bridgeRequested && embedded && parentOrigin) {
    window.parent.postMessage(message, parentOrigin);
  }
}

export const isDashboardVisible = () => document.visibilityState !== 'hidden' && (!(embedded || hosted) || parentVisible);

function announceVisibility() {
  for (const listener of visibilityListeners) listener(isDashboardVisible());
}

export function subscribeDashboardVisibility(listener) {
  visibilityListeners.add(listener);
  return () => visibilityListeners.delete(listener);
}

document.addEventListener('visibilitychange', announceVisibility);

function receive(message) {
  if (message?.type === 'dashboard:response' && channelMode) {
    const request = requests.get(message.id);
    if (!request) return;
    if (message.ok === true) request.resolve(message.value);
    else {
      const status = Number(message.error?.status);
      request.reject(channelError(typeof message.error?.message === 'string' ? message.error.message : 'Homey could not finish this request.',
        Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502));
    }
    return;
  }
  if (message?.type === 'dashboard:error' && channelMode) {
    failChannel(channelError(typeof message.message === 'string' ? message.message : 'Reload the dashboard to reconnect.'));
    return;
  }
  if (message?.type === 'dashboard:visibility' && typeof message.visible === 'boolean') {
    parentVisible = message.visible;
    announceVisibility();
    return;
  }
  if (message?.type !== 'dashboard:connect') return;
  const candidate = message.config;
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
}

if (embedded) window.addEventListener('message', (event) => {
  // A nonce-bearing frame receives credentials only on the private transferred
  // channel, never through an origin-null window message.
  if (bridgeRequested || !parentOrigin || event.source !== window.parent || event.origin !== parentOrigin) return;
  receive(event.data);
});

if (hosted) {
  let hostOrigin = parentOrigin === location.origin ? parentOrigin : null;
  if (!hostOrigin && !document.referrer) {
    try {
      const parent = new URL(window.parent.location.href);
      if (parent.origin === location.origin && /^\/web\/homeys\/[a-f0-9]{24}(?:\/|$)/.test(parent.pathname)) hostOrigin = parent.origin;
    } catch { /* A cross-origin parent cannot claim a passive same-Homey shell. */ }
  }
  window.addEventListener('message', (event) => {
    if (!hostOrigin || event.source !== window.parent || event.origin !== hostOrigin
      || event.data?.type !== 'dashboard:visibility' || typeof event.data.visible !== 'boolean') return;
    parentVisible = event.data.visible;
    announceVisibility();
  });
}

function openChannel() {
  if (port) return;
  let channel;
  // This is the only wildcard message: a noncredential challenge and a private
  // port sent to the immediate parent. The parent validates the exact frame and
  // fresh fragment nonce before sending any session data through that port.
  try {
    channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (event) => receive(event.data);
    port.onmessageerror = () => failChannel(channelError('Homey sent an unreadable dashboard response. Reload to reconnect.'));
    port.start();
    window.parent.postMessage({ type: 'dashboard:ready', nonce }, '*', [channel.port2]);
  } catch {
    channel?.port2.close();
    failChannel(channelError('The Homey dashboard connection could not start. Reload to reconnect.'));
  }
  window.addEventListener('pagehide', () => {
    failChannel(channelError('The dashboard connection closed.', 401));
    port.close();
  }, { once: true });
}

function isCameraOffer(method, path, body) {
  return method === 'POST' && typeof path === 'string'
    && /^\/api\/manager\/videos\/video\/[\w:@.-]+\/offer$/.test(path)
    && body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 1 && Object.prototype.hasOwnProperty.call(body, 'offer')
    && typeof body.offer === 'string' && body.offer.length > 0 && body.offer.length <= 256000;
}

export function requestEmbeddedBroker(route, body, { signal } = {}) {
  if (!channelMode || !port || !config || channelFailure) {
    return Promise.reject(channelFailure ?? channelError('The Homey dashboard connection is not ready. Reload to reconnect.'));
  }
  if (!['request', 'events'].includes(route) || !body || typeof body !== 'object' || Array.isArray(body)) {
    return Promise.reject(channelError('Invalid dashboard request.', 400));
  }
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('The dashboard request was cancelled.'), { name: 'AbortError' }));
  if (requests.size >= 32) return Promise.reject(channelError('Too many dashboard requests. Try again.', 429));
  requestSequence = requestSequence % 2147483647 + 1;
  const id = requestSequence;
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (callback, value) => {
      if (!requests.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, Object.assign(new Error('The dashboard request was cancelled.'), { name: 'AbortError' }));
    requests.set(id, { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) });
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = route === 'request' && isCameraOffer(body.method, body.path, body.body) ? 55000 : 20000;
    timer = setTimeout(() => finish(reject, channelError('Homey has not answered yet. Check the device before trying again.', 504)), timeout);
    try {
      // The parent supplies its own approved session; never forward a claimed
      // token from widget or child request data.
      const { token: ignored, ...payload } = body;
      port.postMessage({ type: 'dashboard:request', id, route, body: payload });
    } catch {
      finish(reject, channelError('The dashboard request could not be sent. Try again.', 502));
    }
  });
}

export function waitForEmbeddedConfig({ timeout = 15000 } = {}) {
  if (!embedded) return Promise.resolve(null);
  if (bridgeRequested && !channelMode) return Promise.reject(new Error('This Homey dashboard connection is unavailable. Reload the dashboard to reconnect.'));
  if (!channelMode && !parentOrigin) return Promise.reject(new Error('Open this dashboard from its Homey app view.'));
  if (channelFailure) return Promise.reject(channelFailure);
  if (config) return Promise.resolve(config);
  if (pending) return pending.promise;
  let timer;
  let waiting;
  const promise = new Promise((resolve, reject) => {
    waiting = pending = {
      resolve(value) { clearTimeout(timer); pending = null; resolve(value); },
      reject(error) { clearTimeout(timer); pending = null; reject(error); },
      promise: null,
    };
    timer = setTimeout(() => {
      pending = null;
      const error = new Error('Homey did not finish connecting. Use Retry in the Homey dashboard view.');
      notifyEmbedded('error', { message: error.message });
      reject(error);
    }, timeout);
  });
  waiting.promise = promise;
  if (channelMode) openChannel();
  else notifyEmbedded('ready');
  return promise;
}
