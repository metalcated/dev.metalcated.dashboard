// Native dashboard creation. Drafts stay in the modal until Homey acknowledges the save.
import { NO_EDIT_PERMISSION, canEditDashboards, createDashboard } from './dashboard-save.js';
import { $, el, toast } from './dom.js';
import { state } from './state.js';

let currentDialog = null;

export function openNewDashboard(onCreated) {
  if (!state.client) return;
  if (!canEditDashboards()) return toast(NO_EDIT_PERMISSION);
  if (currentDialog?.open) return currentDialog.querySelector('input')?.focus();
  const client = state.client;
  const dialog = el('dialog', 'dashboard-create');
  currentDialog = dialog;
  dialog.setAttribute('aria-labelledby', 'dashboard-create-title');
  const form = el('form');
  const heading = el('h2', null, 'New dashboard');
  heading.id = 'dashboard-create-title';
  const intro = el('p', 'dashboard-create-intro', 'Saved to Homey and available in the mobile app.');
  const nameLabel = el('label', null, 'Name');
  nameLabel.htmlFor = 'dashboard-create-name';
  const name = el('input');
  name.id = 'dashboard-create-name';
  name.name = 'name';
  name.required = true;
  name.maxLength = 200;
  name.autocomplete = 'off';
  name.placeholder = 'For example, Living room';
  const sourceLabel = el('label', null, 'Start with');
  sourceLabel.htmlFor = 'dashboard-create-source';
  const source = el('select');
  source.id = 'dashboard-create-source';
  const blank = el('option', null, 'Blank dashboard');
  blank.value = '';
  source.append(blank);
  for (const dashboard of Object.values(state.dashboards).sort((a, b) => a.name.localeCompare(b.name))) {
    const option = el('option', null, `Copy ${dashboard.name}`);
    option.value = dashboard.id;
    source.append(option);
  }
  const copyHint = el('p', 'dashboard-create-hint', 'Copies the layout and widget settings. Notes and app widget saved content start fresh.');
  copyHint.hidden = true;
  source.addEventListener('change', () => { copyHint.hidden = !source.value; });
  const error = el('p', 'dashboard-create-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const actions = el('div', 'dashboard-create-actions');
  const cancel = el('button', 'round-button', 'Cancel');
  cancel.type = 'button';
  const submit = el('button', 'round-button primary', 'Create dashboard');
  submit.type = 'submit';
  actions.append(cancel, submit);
  form.append(heading, intro, nameLabel, name, sourceLabel, source, copyHint, error, actions);
  dialog.append(form);
  let saving = false;
  let uncertain = false;
  cancel.addEventListener('click', () => { if (!saving) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (currentDialog === dialog) currentDialog = null;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    error.hidden = true;
    if (state.client !== client) {
      error.textContent = 'This connection changed. Close this window and try again.';
      error.hidden = false;
      return;
    }
    if (!name.value.trim()) {
      error.textContent = 'Enter a dashboard name.';
      error.hidden = false;
      name.focus();
      return;
    }
    saving = true;
    name.disabled = source.disabled = cancel.disabled = submit.disabled = true;
    submit.textContent = 'Creating…';
    dialog.setAttribute('aria-busy', 'true');
    try {
      const saved = await createDashboard({ name: name.value.trim(), sourceId: source.value || null });
      if (state.client !== client || !dialog.open) return;
      dialog.close();
      onCreated(saved);
    } catch (failure) {
      if (state.client !== client || !dialog.open) return;
      error.textContent = failure.message;
      error.hidden = false;
      // An uncertain creation is reconciled by its unique layout identity rather than sent twice.
      uncertain = failure.creationUncertain === true;
      submit.textContent = uncertain ? 'Check creation' : 'Create dashboard';
    } finally {
      saving = false;
      name.disabled = source.disabled = uncertain;
      cancel.disabled = submit.disabled = false;
      dialog.removeAttribute('aria-busy');
      if (submit.textContent === 'Creating…') submit.textContent = 'Create dashboard';
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  name.focus();
}

export function initDashboardEditor(onCreated) {
  for (const id of ['new-dashboard-button', 'sidebar-new-dashboard']) {
    $(id).addEventListener('click', () => openNewDashboard(onCreated));
  }
}

export function syncDashboardEditor() {
  const connected = state.client != null;
  for (const id of ['new-dashboard-button', 'sidebar-new-dashboard']) {
    const button = $(id);
    button.hidden = !connected;
    button.disabled = !canEditDashboards();
    button.title = button.disabled ? NO_EDIT_PERMISSION : 'Create a dashboard';
  }
}
