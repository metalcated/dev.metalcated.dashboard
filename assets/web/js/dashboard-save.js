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
      mutate(columns);
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
