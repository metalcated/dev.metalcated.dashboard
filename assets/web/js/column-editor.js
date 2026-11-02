// Remove a native column only after reviewing its current widgets. Populated columns transfer their widgets intact.
import { NO_EDIT_PERMISSION, canEditDashboards, removeDashboardColumn } from './dashboard-save.js';
import { el, toast } from './dom.js';
import { state } from './state.js';

let currentDialog = null;

export async function openRemoveColumn(dashboardId, columnId) {
  if (!state.client || state.dashboardId !== dashboardId) return;
  if (!canEditDashboards()) return toast(NO_EDIT_PERMISSION);
  if (currentDialog?.open) {
    currentDialog.querySelector('button')?.focus();
    return currentDialog;
  }
  const client = state.client;
  const current = () => state.client === client && state.dashboardId === dashboardId;
  const dialog = el('dialog', 'dashboard-create column-remove');
  currentDialog = dialog;
  dialog.setAttribute('aria-labelledby', 'column-remove-title');
  const form = el('form');
  const title = el('h2', null, 'Remove column');
  title.id = 'column-remove-title';
  const status = el('p', 'dashboard-create-intro column-remove-status', 'Loading the current column…');
  status.setAttribute('role', 'status');
  const details = el('p', 'dashboard-create-intro column-remove-details');
  details.hidden = true;
  const destinationLabel = el('label', null, 'Move widgets to');
  destinationLabel.htmlFor = 'column-remove-destination';
  destinationLabel.hidden = true;
  const destination = el('select');
  destination.id = 'column-remove-destination';
  destination.hidden = true;
  const error = el('p', 'dashboard-create-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const actions = el('div', 'dashboard-create-actions');
  const cancel = el('button', 'round-button', 'Cancel');
  cancel.type = 'button';
  const submit = el('button', 'round-button primary', 'Remove column');
  submit.type = 'submit';
  submit.disabled = true;
  submit.hidden = true;
  actions.append(cancel, submit);
  form.append(title, status, details, destinationLabel, destination, error, actions);
  dialog.append(form);
  let saving = false;
  let confirmedWidgetIds = null;
  let actionLabel = 'Remove column';
  const active = () => current() && dialog.open && currentDialog === dialog;
  const close = () => { if (!saving) dialog.close(); };
  cancel.addEventListener('click', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (currentDialog === dialog) currentDialog = null;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || !dialog.open || confirmedWidgetIds === null) return;
    if (!active()) { dialog.close(); return; }
    if (!canEditDashboards()) {
      error.textContent = NO_EDIT_PERMISSION;
      error.hidden = false;
      return;
    }
    const targetColumnId = confirmedWidgetIds.length ? destination.value : null;
    if (confirmedWidgetIds.length && !targetColumnId) {
      error.textContent = 'Choose a column for these widgets.';
      error.hidden = false;
      destination.focus();
      return;
    }
    saving = true;
    destination.disabled = cancel.disabled = submit.disabled = true;
    submit.textContent = 'Saving…';
    dialog.setAttribute('aria-busy', 'true');
    error.hidden = true;
    try {
      await removeDashboardColumn(dashboardId, columnId, { targetColumnId, expectedWidgetIds: [...confirmedWidgetIds] });
      if (active()) dialog.close();
    } catch (failure) {
      if (!active()) { dialog.close(); return; }
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      saving = false;
      destination.disabled = cancel.disabled = submit.disabled = false;
      submit.textContent = actionLabel;
      dialog.removeAttribute('aria-busy');
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
  try {
    const dashboard = await client.api('GET', `/api/manager/dashboards/dashboard/${encodeURIComponent(dashboardId)}`);
    if (!active()) { dialog.close(); return; }
    const columns = dashboard?.columns;
    if (!Array.isArray(columns)) throw new Error('Homey returned an invalid dashboard. Close this window and try again.');
    const index = columns.findIndex((column) => column.id === columnId);
    const column = columns[index];
    if (!column || !Array.isArray(column.widgets)) throw new Error('This column was removed meanwhile. Reopen the dashboard.');
    title.textContent = `Remove column ${index + 1}`;
    status.hidden = true;
    details.hidden = false;
    if (columns.length <= 1) {
      details.textContent = 'Keep at least one column in the dashboard. Add another column before removing this one.';
      return dialog;
    }
    confirmedWidgetIds = column.widgets.map((widget) => widget.id);
    if (confirmedWidgetIds.length) {
      const count = confirmedWidgetIds.length;
      details.textContent = `This column contains ${count} ${count === 1 ? 'widget' : 'widgets'}. Move ${count === 1 ? 'it' : 'them'} to another column before removing this one. All widget settings and saved content will be kept.`;
      for (const [at, candidate] of columns.entries()) {
        if (candidate.id === columnId) continue;
        const count = candidate.widgets?.length ?? 0;
        const option = el('option', null, `Column ${at + 1} · ${count} ${count === 1 ? 'widget' : 'widgets'}`);
        option.value = candidate.id;
        destination.append(option);
      }
      destination.value = columns.find((candidate) => candidate.id !== columnId).id;
      destinationLabel.hidden = destination.hidden = false;
      actionLabel = 'Move widgets and remove column';
    } else {
      details.textContent = 'This column is empty. Removing it leaves your widgets unchanged.';
    }
    submit.textContent = actionLabel;
    submit.disabled = false;
    submit.hidden = false;
  } catch (failure) {
    if (!active()) { dialog.close(); return; }
    status.hidden = true;
    error.textContent = failure.message;
    error.hidden = false;
  }
  return dialog;
}
