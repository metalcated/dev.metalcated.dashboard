// Changes to a dashboard on the Homey (edit mode and widget settings). Each change is made to the dashboard as Homey
// has it right then, so one made meanwhile in the Homey app isn't lost, and saved straight away.

import { state } from './state.js';

let scopes = null; // What the key may do, once known.

// A scope is granted by itself or by any parent (homey.dashboard grants homey.dashboard.readonly; homey grants all).
const grants = (scope) => scope.split('.').some((_, index, parts) => scopes.includes(parts.slice(0, index + 1).join('.')));

export async function loadKeyScopes() {
  const client = state.client;
  scopes = null;
  const session = await client.api('GET', '/api/manager/sessions/session/me').catch(() => null);
  if (state.client !== client) return;
  scopes = session?.intersectedScopes ?? session?.scopes ?? null;
}

// Unknown (the session couldn't be read) counts as allowed: Homey then decides when saving.
export function canEditDashboards() {
  return scopes == null || grants('homey.dashboard');
}

export const NO_EDIT_PERMISSION = "This browser's key can only view dashboards. Editing them here needs a key with the "
  + 'Dashboards permission (homey.dashboard); Apps → Web Dashboard → Configure in the Homey app explains how.';

const announce = (dashboard) => document.dispatchEvent(new CustomEvent('dashboard-saved', { detail: dashboard }));

// Changes are saved one after the other, so a quick second move builds on the first.
let queue = Promise.resolve();
const pending = new Map(); // dashboard id → changes not saved yet

// While changes to a dashboard are being saved, Homey's announcements of the earlier ones would briefly undo the later
// ones on the page, so the page waits for the last save instead.
export const isSaving = (dashboardId) => (pending.get(dashboardId) ?? 0) > 0;

const DASHBOARDS_PATH = '/api/manager/dashboards/dashboard';
const creations = new WeakMap(); // The current connection owns its in-flight or unresolved create attempts.

function requireEditing() {
  if (!canEditDashboards()) throw new Error(NO_EDIT_PERMISSION);
}

// randomUUID is restricted to secure contexts; getRandomValues also works on Homey's local HTTP address.
function newIdentity() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function connectionGuard(client) {
  return () => {
    if (client == null || state.client !== client) throw new Error('This connection changed. Reopen the dashboard before editing.');
  };
}

const definiteRefusal = (error) => error.status >= 400 && error.status < 500 && error.status !== 408;
const uncertainCreation = () => Object.assign(new Error('Homey may have created this dashboard, but its response was lost. '
  + 'Refresh the dashboard list before creating it again.'), { creationUncertain: true });

// A unique native column identity lets a lost response be reconciled without posting a second dashboard. A repeated
// attempt with the same name/source on this connection only checks that identity until Homey confirms the result.
export function createDashboard({ name, sourceId = null } = {}) {
  requireEditing();
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) throw new Error('Enter a dashboard name of 1–200 characters.');
  if (sourceId !== null && (typeof sourceId !== 'string' || !sourceId)) throw new Error('Choose an existing dashboard to copy.');
  const client = state.client;
  const requireCurrent = connectionGuard(client);
  requireCurrent();
  const key = JSON.stringify([name.trim(), sourceId]);
  let attempts = creations.get(client);
  if (!attempts) { attempts = new Map(); creations.set(client, attempts); }
  let attempt = attempts.get(key);
  if (attempt?.pending) return attempt.pending;
  if (!attempt) { attempt = { body: null, marker: null, uncertain: false, pending: null }; attempts.set(key, attempt); }

  const reconcile = async () => {
    requireCurrent();
    const dashboards = await client.api('GET', DASHBOARDS_PATH);
    requireCurrent();
    return Object.values(dashboards ?? {}).find((dashboard) => Array.isArray(dashboard?.columns)
      && dashboard.columns.some((column) => column.id === attempt.marker)) ?? null;
  };

  const work = async () => {
    requireCurrent();
    requireEditing();
    if (attempt.uncertain) {
      const found = await reconcile().catch((error) => { requireCurrent(); throw uncertainCreation(); });
      if (!found) throw uncertainCreation();
      return found;
    }
    let columns = [];
    if (sourceId !== null) {
      let source;
      try { source = await client.api('GET', `${DASHBOARDS_PATH}/${encodeURIComponent(sourceId)}`); }
      catch (error) {
        if (error.status === 404) throw new Error('The dashboard to copy was deleted meanwhile. Choose another dashboard.');
        throw error;
      }
      requireCurrent();
      if (!Array.isArray(source?.columns)) throw new Error('Homey returned an invalid dashboard to copy.');
      columns = structuredClone(source.columns);
      for (const column of columns) {
        if (!column || !Array.isArray(column.widgets)) throw new Error('Homey returned an invalid dashboard to copy.');
        column.id = newIdentity();
        for (const widget of column.widgets) {
          if (!widget || typeof widget !== 'object' || Array.isArray(widget)) throw new Error('Homey returned an invalid dashboard to copy.');
          widget.id = newIdentity();
        }
      }
    }
    if (columns.length === 0) columns.push({ id: newIdentity(), widgets: [] });
    attempt.body = { name: name.trim(), columns };
    attempt.marker = columns[0].id;
    requireCurrent();
    try {
      const saved = await client.api('POST', DASHBOARDS_PATH, attempt.body);
      requireCurrent();
      if (typeof saved?.id !== 'string' || !Array.isArray(saved.columns)
          || !saved.columns.some((column) => column.id === attempt.marker)) throw uncertainCreation();
      return saved;
    } catch (error) {
      if (definiteRefusal(error)) {
        if (error.status === 403) throw new Error(NO_EDIT_PERMISSION);
        throw error;
      }
      attempt.uncertain = true;
      requireCurrent();
      const found = await reconcile().catch(() => { requireCurrent(); throw uncertainCreation(); });
      if (found) return found;
      throw uncertainCreation();
    }
  };
  const saving = queue.then(work);
  queue = saving.catch(() => {});
  attempt.pending = saving.then((saved) => {
    requireCurrent();
    attempts.delete(key);
    announce(saved);
    return saved;
  }, (error) => {
    attempt.pending = null;
    if (!attempt.uncertain) attempts.delete(key);
    throw error;
  });
  return attempt.pending;
}

export function addDashboardColumn(dashboardId) {
  requireEditing();
  const column = { id: newIdentity(), widgets: [] };
  return updateDashboard(dashboardId, (columns) => {
    if (columns.length >= 50) throw new Error('This dashboard already has 50 columns.');
    columns.push(structuredClone(column));
  });
}

export function addDashboardWidget(dashboardId, columnId, widget) {
  requireEditing();
  if (typeof columnId !== 'string' || !columnId || widget == null || typeof widget !== 'object'
      || Array.isArray(widget) || typeof widget.type !== 'string' || !widget.type) throw new Error('Choose a widget and a dashboard column.');
  const added = { ...structuredClone(widget), id: newIdentity() };
  return updateDashboard(dashboardId, (columns) => {
    const column = columns.find((value) => value.id === columnId);
    if (!column || !Array.isArray(column.widgets)) throw new Error('This column was removed from the dashboard meanwhile. Choose another column.');
    column.widgets.push(structuredClone(added));
  });
}

// Drops address native identities rather than screen positions. Resolve them again in the queued fresh layout so
// a phone adding or moving a different widget while this drag was in progress cannot be overwritten.
export function moveDashboardWidget(dashboardId, widgetId, targetColumnId, beforeWidgetId = null) {
  requireEditing();
  if (typeof widgetId !== 'string' || !widgetId || typeof targetColumnId !== 'string' || !targetColumnId
      || (beforeWidgetId !== null && (typeof beforeWidgetId !== 'string' || !beforeWidgetId))) {
    throw new Error('Choose a widget and a destination in the dashboard grid.');
  }
  return updateDashboard(dashboardId, (columns) => {
    requireEditing();
    const from = locateWidget(columns, widgetId);
    const target = columns.find((column) => column.id === targetColumnId);
    if (!target || !Array.isArray(target.widgets)) throw new Error('The destination column was removed meanwhile. Choose another position.');
    const before = beforeWidgetId === null ? target.widgets.length : target.widgets.findIndex((widget) => widget.id === beforeWidgetId);
    if (before < 0) throw new Error('The widget beside this drop position moved or was removed meanwhile. Choose another position.');
    const source = columns[from.column];
    if (source === target) {
      // A drop on itself, directly before its next sibling, or after the last widget changes nothing.
      if (beforeWidgetId === widgetId || before - (before > from.index ? 1 : 0) === from.index) return false;
    }
    source.widgets.splice(from.index, 1);
    const at = beforeWidgetId === null ? target.widgets.length : target.widgets.findIndex((widget) => widget.id === beforeWidgetId);
    target.widgets.splice(at, 0, from.widget);
  });
}

// Removing a populated column moves its widgets intact. The modal confirms the membership it actually showed;
// changes to that membership require a fresh confirmation instead of moving an unexpected group of widgets.
export function removeDashboardColumn(dashboardId, columnId, { targetColumnId = null, expectedWidgetIds } = {}) {
  requireEditing();
  if (typeof columnId !== 'string' || !columnId || (targetColumnId !== null && (typeof targetColumnId !== 'string' || !targetColumnId))
      || !Array.isArray(expectedWidgetIds) || expectedWidgetIds.some((id) => typeof id !== 'string' || !id)
      || new Set(expectedWidgetIds).size !== expectedWidgetIds.length) {
    throw new Error('Reopen Remove column to confirm its current widgets.');
  }
  const confirmed = new Set(expectedWidgetIds);
  return updateDashboard(dashboardId, (columns) => {
    requireEditing();
    const sourceIndex = columns.findIndex((column) => column.id === columnId);
    const source = columns[sourceIndex];
    if (!source || !Array.isArray(source.widgets)) throw new Error('This column was removed meanwhile. Reopen the dashboard.');
    if (columns.length <= 1) throw new Error('Keep at least one column in the dashboard.');
    if (source.widgets.length !== confirmed.size || source.widgets.some((widget) => !confirmed.has(widget.id))) {
      throw new Error('The widgets in this column changed meanwhile. Reopen Remove column to review them.');
    }
    if (source.widgets.length > 0) {
      const target = columns.find((column) => column.id === targetColumnId);
      if (!target || !Array.isArray(target.widgets) || target === source) {
        throw new Error('Choose another existing column for these widgets.');
      }
      target.widgets.push(...source.widgets);
    }
    columns.splice(sourceIndex, 1);
  });
}

// mutate(columns) changes the dashboard's columns in place; it throws to cancel. The saved dashboard is announced as
// 'dashboard-saved', so the page shows it before Homey's own update arrives. Optimistic: the page shows the change
// before it is saved (a move), and what Homey has if saving fails.
export function updateDashboard(dashboardId, mutate, { optimistic = false } = {}) {
  const client = state.client;
  const current = () => client != null && state.client === client;
  const requireCurrent = () => {
    if (!current()) throw new Error('This connection changed. Reopen the dashboard before editing.');
  };
  requireCurrent();
  const path = `/api/manager/dashboards/dashboard/${encodeURIComponent(dashboardId)}`;
  if (optimistic && state.dashboards[dashboardId] != null) {
    const local = structuredClone(state.dashboards[dashboardId]);
    mutate(local.columns);
    announce(local);
  }
  pending.set(dashboardId, (pending.get(dashboardId) ?? 0) + 1);
  const save = queue.then(async () => {
    try {
      requireCurrent();
      const dashboard = await client.api('GET', path);
      requireCurrent();
      const columns = structuredClone(dashboard.columns ?? []);
      // An explicit false reports a fresh native no-op without sending a redundant write.
      if (mutate(columns) === false) return dashboard;
      const saved = await client.api('PUT', path, { columns });
      requireCurrent();
      return saved;
    } finally {
      pending.set(dashboardId, pending.get(dashboardId) - 1);
    }
  });
  queue = save.catch(() => {});
  return save.then((saved) => {
    if (current() && !isSaving(dashboardId)) announce(saved);
    return saved;
  }, async (error) => {
    if (current() && optimistic && !isSaving(dashboardId)) {
      const dashboard = await client.api('GET', path).catch(() => null);
      if (current() && dashboard) announce(dashboard);
    }
    if (error.status === 403) throw new Error(NO_EDIT_PERMISSION);
    if (error.status === 404) throw new Error('This dashboard was deleted meanwhile.');
    throw error;
  });
}

// The column and place of a widget in a dashboard's columns, or an error if it was removed meanwhile.
export function locateWidget(columns, widgetId) {
  for (const [column, { widgets }] of columns.entries()) {
    const index = widgets.findIndex((widget) => widget.id === widgetId);
    if (index !== -1) return { column, index, widget: widgets[index] };
  }
  throw new Error('This widget was removed from the dashboard meanwhile.');
}
