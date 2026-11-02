// Web size preferences live in Homey's settings database, separate from native mobile widget definitions.
import { APP_ID } from './config.js';
import { NO_EDIT_PERMISSION, canEditDashboards } from './dashboard-save.js';
import { subscribe } from './realtime.js';
import { state } from './state.js';

export const WEB_COLUMN_UNITS = 360;
export const WEB_SIZE_STEP = 20;
const appId = () => APP_ID ?? state.config?.appId ?? 'dev.schweiger.dashboard';
let sizes = {};
let sizesClient = null;
let watcher = null;
let queue = Promise.resolve();
let revisionClient = null;
let revision = 0;

function revisionFor(client) {
  if (revisionClient !== client) { revisionClient = client; revision = 0; }
  return revision;
}

export function normalizeWidgetSize(size) {
  if (size == null || typeof size !== 'object' || Array.isArray(size)
      || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  const snap = (value, min, max) => Math.max(min, Math.min(max, Math.round(value / WEB_SIZE_STEP) * WEB_SIZE_STEP));
  return { width: snap(size.width, 120, WEB_COLUMN_UNITS), height: snap(size.height, 80, 1440) };
}

const same = (left, right) => left?.width === right?.width && left?.height === right?.height;
function sanitized(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return {};
  return Object.fromEntries(Object.entries(next).flatMap(([id, size]) => {
    const value = normalizeWidgetSize(size);
    return value && value.width === size.width && value.height === size.height ? [[id, value]] : [];
  }));
}

function apply(next, client) {
  if (state.client !== client || !next || typeof next !== 'object' || Array.isArray(next)) return false;
  const before = sizesClient === client ? sizes : {};
  sizes = sanitized(next);
  sizesClient = client;
  revisionFor(client); revision += 1;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(sizes)])].filter((id) => !same(before[id], sizes[id]));
  if (changed.length && watcher?.client === client) watcher.handler(changed);
  return true;
}

export function widgetSize(id) {
  const value = sizesClient === state.client ? sizes[id] : null;
  return value ? { ...value } : null;
}

export const hasCustomWidgetSize = (id) => widgetSize(id) != null;

export async function loadWidgetSizes() {
  const client = state.client;
  if (!client) { sizes = {}; sizesClient = null; return false; }
  if (sizesClient !== client) { sizes = {}; sizesClient = client; }
  const requestedAt = revisionFor(client);
  try {
    const loaded = await client.api('GET', `/api/app/${appId()}/widget-sizes`);
    if (state.client !== client) return false;
    // A later observed event or acknowledgement is newer than this in-flight read.
    if (revisionFor(client) !== requestedAt) return true;
    return apply(loaded, client);
  } catch { return false; }
}

// Realtime changes apply styles in place; callers must not redraw or remount the affected widgets.
export function watchWidgetSizes(handler) {
  const client = state.client;
  const watched = { client, handler };
  watcher = watched;
  const unsubscribe = subscribe(`homey:app:${appId()}`, 'widget-sizes', (next) => {
    if (state.client === client) apply(next, client);
  });
  return () => { unsubscribe?.(); if (watcher === watched) watcher = null; };
}

export function saveWidgetSize(id, size) {
  const client = state.client;
  const normalized = size === null ? null : normalizeWidgetSize(size);
  if (!client) throw new Error('Connect to Homey before resizing a widget.');
  if (!canEditDashboards()) throw new Error(NO_EDIT_PERMISSION);
  if (typeof id !== 'string' || !id || (size !== null && !normalized)) throw new Error('Choose a valid widget size.');
  const requireCurrent = () => {
    if (state.client !== client) throw new Error('This connection changed. Reopen the dashboard before resizing.');
    if (!canEditDashboards()) throw new Error(NO_EDIT_PERMISSION);
    const exists = Object.values(state.dashboards).some((dashboard) => (dashboard.columns ?? [])
      .some((column) => (column.widgets ?? []).some((widget) => widget.id === id)));
    if (!exists) throw new Error('This widget was removed from the dashboard meanwhile.');
  };
  requireCurrent();
  const save = queue.then(async () => {
    requireCurrent();
    const requestedAt = revisionFor(client);
    const saved = await client.api('PUT', `/api/app/${appId()}/widget-sizes/${encodeURIComponent(id)}`, {
      token: client.token, size: normalized,
    });
    requireCurrent();
    if (revisionFor(client) === requestedAt) {
      if (!apply(saved, client)) throw new Error('Homey saved the web size but returned an unreadable response. Reload the dashboard.');
    } else {
      // Full maps from an earlier PUT must not erase a newer change received from another browser. Read the
      // authoritative map once; if another event arrives during that read, its already-observed map wins.
      const refreshAt = revisionFor(client);
      let latest;
      try { latest = await client.api('GET', `/api/app/${appId()}/widget-sizes`); }
      catch { throw new Error('The web size was saved, but its latest settings could not be refreshed. Reload the dashboard.'); }
      requireCurrent();
      if (revisionFor(client) === refreshAt && !apply(latest, client)) {
        throw new Error('The web size was saved, but its latest settings could not be read. Reload the dashboard.');
      }
    }
    return widgetSize(id);
  });
  queue = save.catch(() => {});
  return save;
}

export function applyWidgetSize(section, id, preview = undefined) {
  const size = preview === undefined ? widgetSize(id) : normalizeWidgetSize(preview);
  section.classList.toggle('has-web-size', size != null);
  if (size) {
    section.style.setProperty('--web-widget-width', `${size.width / WEB_COLUMN_UNITS * 100}%`);
    section.style.setProperty('--web-widget-ratio', `${size.width} / ${size.height}`);
  } else {
    section.style.removeProperty('--web-widget-width');
    section.style.removeProperty('--web-widget-ratio');
  }
}
