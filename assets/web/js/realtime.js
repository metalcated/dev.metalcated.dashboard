// Live updates over socket.io, using the same handshake as the Homey apps.

import { state } from './state.js';
import { isDashboardVisible, subscribeDashboardVisibility } from './embedded.js';

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.append(script);
  });
}

export function createRealtime(client, callbacks) {
  if (client.transport === 'broker') return createBrokerRealtime(client, callbacks);
  const { base, token } = client;
  const { onStatus, onReconnect } = callbacks;
  const listeners = new Set();
  const subscriptions = new Map();
  let apiSocket = null;
  let connectedBefore = false;

  const root = window.io(base, { transports: ['websocket'] });

  // Homey authenticates the connection on the root namespace, then hands out the namespace to use.
  const handshake = () => {
    root.emit('handshakeClient', { token }, (error, result) => {
      if (error) {
        onStatus('error', error.error ?? 'Realtime handshake failed');
        return;
      }
      if (apiSocket == null) {
        apiSocket = root.io.socket(result.namespace);
        apiSocket.on('connect', () => {
          for (const uri of subscriptions.keys()) apiSocket.emit('subscribe', uri);
          onStatus('live', 'Live');
          if (connectedBefore) onReconnect();
          connectedBefore = true;
        });
        apiSocket.on('disconnect', () => onStatus('offline', 'Offline'));
        // After a reconnect the namespace can be rejected because it raced the handshake.
        apiSocket.on('connect_error', () => {
          setTimeout(() => {
            if (root.connected && !apiSocket.active) handshake();
          }, 2000);
        });
        apiSocket.onAny((uri, event, data) => {
          for (const listener of listeners) {
            if (listener.uri === uri && listener.event === event) listener.fn(data);
          }
        });
      }
      if (!apiSocket.active) apiSocket.connect();
    });
  };
  root.on('connect', handshake);
  root.on('disconnect', () => onStatus('offline', 'Offline'));
  root.on('connect_error', () => onStatus('offline', 'Offline'));

  function on(uri, event, fn) {
    const listener = { uri, event, fn };
    listeners.add(listener);
    const count = subscriptions.get(uri) ?? 0;
    subscriptions.set(uri, count + 1);
    if (count === 0 && apiSocket?.connected) apiSocket.emit('subscribe', uri);

    return () => {
      listeners.delete(listener);
      const remaining = (subscriptions.get(uri) ?? 1) - 1;
      if (remaining > 0) {
        subscriptions.set(uri, remaining);
      } else {
        subscriptions.delete(uri);
        if (apiSocket?.connected) apiSocket.emit('unsubscribe', uri);
      }
    };
  }

  const close = () => {
    apiSocket?.disconnect();
    root.disconnect();
  };
  window.addEventListener('pagehide', close, { once: true });
  return { on, close };
}

// The app owns the Homey session and relays permitted events. The browser never
// authenticates a socket using the owner's API key.
function createBrokerRealtime(client, { onStatus, onReconnect, onUnauthorized }) {
  const listeners = new Set();
  let cursor;
  let timer = null;
  let active = null;
  let closed = false;
  let connectedBefore = false;
  let offline = true;

  function schedule(delay = 1000) {
    if (closed || active || !isDashboardVisible()) return;
    clearTimeout(timer);
    timer = setTimeout(poll, delay);
  }

  async function poll() {
    timer = null;
    if (closed || active || !isDashboardVisible()) return;
    const controller = new AbortController();
    active = controller;
    const subscriptions = [...new Map([...listeners].map(({ uri, event }) => [JSON.stringify([uri, event]), { uri, event }])).values()];
    try {
      const result = await client.broker('events', { subscriptions, ...(cursor == null ? {} : { cursor }) }, { signal: controller.signal });
      if (closed || controller.signal.aborted) return;
      if (typeof result?.cursor === 'string') cursor = result.cursor;
      const resync = result?.reset === true || (connectedBefore && offline);
      connectedBefore = true;
      offline = false;
      onStatus('live', 'Live');
      if (resync) onReconnect();
      for (const data of result?.events ?? []) {
        for (const listener of [...listeners]) {
          if (listener.uri !== data.uri || listener.event !== data.event) continue;
          try {
            Promise.resolve(listener.fn(data.data)).catch((error) => console.error('Dashboard event:', error));
          } catch (error) {
            console.error('Dashboard event:', error);
          }
        }
      }
    } catch (error) {
      if (closed || controller.signal.aborted) return;
      offline = true;
      if (error.status === 401) {
        close();
        onStatus('offline', 'Connection expired');
        onUnauthorized?.(error);
      } else {
        onStatus(error.status === 403 ? 'error' : 'offline', error.status === 403 ? 'Live updates are not permitted' : 'Offline');
      }
    } finally {
      if (active === controller) active = null;
      schedule();
    }
  }

  const stopVisibility = subscribeDashboardVisibility((visible) => {
    if (visible) schedule(0);
    else {
      clearTimeout(timer);
      active?.abort();
    }
  });

  function close() {
    closed = true;
    clearTimeout(timer);
    active?.abort();
    stopVisibility();
    window.removeEventListener('pagehide', close);
  }
  window.addEventListener('pagehide', close, { once: true });

  function on(uri, event, fn) {
    const listener = { uri, event, fn };
    listeners.add(listener);
    schedule(0);
    return () => listeners.delete(listener);
  }

  schedule(0);
  return { on, close };
}

export function subscribe(uri, event, fn) {
  return state.realtime ? state.realtime.on(uri, event, fn) : () => {};
}
