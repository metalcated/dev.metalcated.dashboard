// How each app widget runs, chosen in its settings (sheets/widget-settings.js) and kept by the app, so every browser
// runs it the same way: 'sandboxed' (the default: an opaque origin without storage, so it can't read the API key this
// page keeps), 'storage' (sandboxed, with localStorage kept by this page, see widget-storage.js) or 'trusted' (no
// sandbox, as in the Homey app; it could read the API key). Only when served by the app; otherwise all are sandboxed.

import { APP_ID, servedByHomey } from './config.js';
import { subscribe } from './realtime.js';
import { state } from './state.js';

export const WIDGET_MODES = ['sandboxed', 'storage', 'trusted'];

let modes = {};
let onChange = () => {};

// New modes, from the app's announcement or a save here; the widgets whose mode changed are drawn again.
function apply(next) {
  const previous = modes;
  modes = next ?? {};
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(modes)])].filter((id) => previous[id] !== modes[id]);
  if (changed.length > 0) onChange(changed);
}

export const canChooseWidgetMode = () => servedByHomey;

export function widgetMode(widgetId) {
  return modes[widgetId] ?? WIDGET_MODES[0];
}

export async function loadWidgetModes() {
  if (!servedByHomey) return;
  const client = state.client;
  const loaded = await client.api('GET', `/api/app/${APP_ID}/widget-modes`).catch(() => null);
  if (state.client === client) modes = loaded ?? modes;
}

// handler gets the ids of the widgets whose mode changed.
export function watchWidgetModes(handler) {
  if (!servedByHomey) return;
  const client = state.client;
  onChange = handler;
  subscribe(`homey:app:${APP_ID}`, 'widget-modes', (next) => { if (state.client === client) apply(next); });
}

// Needs a key that may change dashboards (homey.dashboard), like the widget's other settings.
export async function saveWidgetMode(widgetId, mode) {
  apply(await state.client.api('PUT', `/api/app/${APP_ID}/widget-modes/${encodeURIComponent(widgetId)}`, {
    token: state.client.token,
    mode,
  }));
}
