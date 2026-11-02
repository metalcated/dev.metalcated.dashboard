import { NO_EDIT_PERMISSION, addDashboardWidget, canEditDashboards } from '../dashboard-save.js';
import { loadData } from '../data.js';
import { el, toast } from '../dom.js';
import { CHEVRON_RIGHT, CLOSE_ICON, SEARCH_ICON } from '../icons.js';
import { state } from '../state.js';
import { WIDGET_CATALOG, appWidgetEntries, createWidgetDraft } from '../widget-catalog.js';
import { openWidgetSettings } from './widget-settings.js';

// Add opens settings on an unsaved draft. Cancel leaves the dashboard and Homey's widget inventory untouched.
export async function openWidgetPicker(dashboardId, columnId) {
  if (!canEditDashboards()) return toast(NO_EDIT_PERMISSION);
  const client = state.client;
  const current = () => client != null && state.client === client;
  document.querySelector('dialog.widget-settings')?.close();
  const dialog = el('dialog', 'widget-settings widget-picker');
  dialog.setAttribute('aria-labelledby', 'widget-picker-title');
  const header = el('div', 'ws-header');
  const close = el('button', 'sheet-close');
  close.type = 'button';
  close.innerHTML = CLOSE_ICON;
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => dialog.close());
  const title = el('h2', 'ws-title', 'Add widget');
  title.id = 'widget-picker-title';
  header.append(close, title);
  const content = el('div', 'ws-content');
  const search = el('label', 'ws-search');
  search.innerHTML = SEARCH_ICON;
  const input = el('input');
  input.type = 'search';
  input.placeholder = 'Search widgets…';
  input.setAttribute('aria-label', 'Search widgets');
  search.append(input);
  const list = el('div', 'widget-picker-list');
  const status = el('p', 'ws-hint', 'Loading app widgets…');
  status.setAttribute('role', 'status');
  content.append(search, list, status);
  dialog.append(header, content);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  dialog.showModal();
  let entries = [...WIDGET_CATALOG];
  let choosing = false;
  const choose = async (entry) => {
    if (choosing || !current() || !dialog.open) return;
    choosing = true;
    dialog.close();
    try {
      await openWidgetSettings(dashboardId, createWidgetDraft(entry), entry.name, {
        creating: true,
        actionLabel: 'Add widget',
        onSave: async (widget) => {
          if (!current()) throw new Error('This connection changed. Reopen the dashboard before adding a widget.');
          return addDashboardWidget(dashboardId, columnId, widget);
        },
      });
    } catch (error) { if (current()) toast(error.message); }
  };
  const draw = () => {
    const needle = input.value.trim().toLocaleLowerCase();
    const visible = entries.filter((entry) => `${entry.name} ${entry.group}`.toLocaleLowerCase().includes(needle));
    list.replaceChildren();
    for (const groupName of [...new Set(visible.map((entry) => entry.group))]) {
      list.append(el('h3', 'ws-section', groupName));
      const group = el('div', 'ws-group');
      for (const entry of visible.filter((candidate) => candidate.group === groupName)) {
        const row = el('button', 'ws-row widget-picker-item');
        row.type = 'button';
        row.append(el('span', 'ws-label', entry.name));
        row.insertAdjacentHTML('beforeend', CHEVRON_RIGHT);
        row.addEventListener('click', () => choose(entry));
        group.append(row);
      }
      list.append(group);
    }
    if (!visible.length) list.append(el('p', 'ws-hint', 'No widgets match your search.'));
  };
  input.addEventListener('input', draw);
  draw();
  try {
    const { data, errors } = await loadData(['appWidgets']);
    if (!current() || !dialog.open) return;
    if (data.appWidgets) {
      state.data.appWidgets = data.appWidgets;
      entries = [...WIDGET_CATALOG, ...appWidgetEntries(data.appWidgets)];
      draw();
    }
    status.textContent = errors.appWidgets ? 'App widgets could not be loaded. Close and reopen Add widget to try again.' : '';
  } catch {
    if (current() && dialog.open) status.textContent = 'App widgets could not be loaded. Close and reopen Add widget to try again.';
  }
}
