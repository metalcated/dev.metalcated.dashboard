// Edit mode, as in the Homey app: the Edit button turns it on (not in kiosk mode), and each widget gets a menu (•••)
// to move it, open its settings (sheets/widget-settings.js) or remove it. Each change is saved to the Homey straight
// away (dashboard-save.js), so Done only leaves edit mode. New widgets start as unsaved settings drafts.

import { NO_EDIT_PERMISSION, addDashboardColumn, canEditDashboards, locateWidget, updateDashboard } from './dashboard-save.js';
import { $, el, toast } from './dom.js';
import { CHEVRON_DOWN, CHEVRON_LEFT, CHEVRON_RIGHT, CHEVRON_UP, EDIT_ICON, MORE_ICON, TRASH_ICON } from './icons.js';
import { isKiosk } from './kiosk.js';
import { openWidgetSettings } from './sheets/widget-settings.js';
import { openWidgetPicker } from './sheets/widget-picker.js';
import { state } from './state.js';

let menu = null; // The open widget menu, if any.
let menuAnchor = null; // Its widget's ••• button.

export function isEditing() {
  return document.documentElement.classList.contains('editing');
}

export function setEditing(on) {
  closeMenu();
  document.documentElement.classList.toggle('editing', on);
  $('edit-button').textContent = on ? 'Done' : 'Edit';
  $('edit-button').classList.toggle('is-done', on);
}

function closeMenu() {
  menu?.remove();
  menu = null;
  menuAnchor = null;
}

// Under the ••• button, kept on screen; it follows the widget while the page scrolls.
function placeMenu() {
  if (menu == null) return;
  if (!menuAnchor.isConnected) return closeMenu();
  const box = menuAnchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.top = `${Math.min(box.bottom + 8, innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(box.right - width, innerWidth - width - 8))}px`;
}

// Saves a change, shown straight away; the menu closes either way and a refused change says why.
async function change(dashboardId, mutate) {
  closeMenu();
  try {
    await updateDashboard(dashboardId, mutate, { optimistic: true });
  } catch (error) {
    toast(error.message);
  }
}

function openMenu(anchor, { dashboardId, widgetId, name }) {
  closeMenu();
  // Where the widget is now: earlier moves didn't draw the board again.
  const all = state.dashboards[dashboardId]?.columns ?? [];
  let found;
  try {
    found = locateWidget(all, widgetId);
  } catch (error) {
    toast(error.message);
    return;
  }
  const { column, index, widget } = found;
  const columns = all.length;
  const length = all[column].widgets.length;
  menu = el('div', 'widget-menu');
  menu.setAttribute('role', 'menu');

  const moves = el('div', 'widget-menu-moves');
  const move = (icon, label, enabled, mutate) => {
    const button = el('button');
    button.type = 'button';
    button.innerHTML = icon;
    button.setAttribute('aria-label', label);
    button.disabled = !enabled;
    button.addEventListener('click', () => change(dashboardId, mutate));
    moves.append(button);
  };
  // Moves act on where the widget is now, which may differ from what this page drew.
  const shift = (columnStep, indexStep) => (all) => {
    const from = locateWidget(all, widget.id);
    const target = all[from.column + columnStep];
    if (target == null) return;
    all[from.column].widgets.splice(from.index, 1);
    const at = columnStep === 0 ? from.index + indexStep : Math.min(from.index, target.widgets.length);
    target.widgets.splice(Math.max(0, Math.min(at, target.widgets.length)), 0, from.widget);
  };
  move(CHEVRON_UP, 'Move up', index > 0, shift(0, -1));
  move(CHEVRON_DOWN, 'Move down', index < length - 1, shift(0, 1));
  move(CHEVRON_LEFT, 'Move to the column on the left', column > 0, shift(-1, 0));
  move(CHEVRON_RIGHT, 'Move to the column on the right', column < columns - 1, shift(1, 0));

  const item = (label, icon, className, onClick) => {
    const button = el('button', className);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.append(el('span', null, label));
    button.insertAdjacentHTML('beforeend', icon);
    button.addEventListener('click', onClick);
    return button;
  };
  const edit = item('Edit Widget', EDIT_ICON, '', () => {
    closeMenu();
    openWidgetSettings(dashboardId, widget, name);
  });
  // A second tap removes it, so a stray one doesn't.
  const remove = item('Remove Widget', TRASH_ICON, 'is-danger', () => {
    if (!remove.classList.contains('is-confirming')) {
      remove.classList.add('is-confirming');
      remove.firstChild.textContent = 'Tap again to remove';
      return;
    }
    change(dashboardId, (all) => {
      const { column: at, index: place } = locateWidget(all, widget.id);
      all[at].widgets.splice(place, 1);
    });
  });
  menu.append(moves, edit, remove);
  document.body.append(menu);
  menuAnchor = anchor;
  placeMenu();
  menu.querySelector('[role="menuitem"]').focus({ preventScroll: true });
}

// The edit-mode layer over a drawn widget (render.js): it takes the taps, so the widget can't be used while editing,
// and opens the widget's menu. widget: { dashboardId, widgetId, name }.
export function addEditTools(section, widget) {
  const layer = el('button', 'widget-edit');
  layer.type = 'button';
  layer.setAttribute('aria-label', `Options for ${widget.name}`);
  layer.setAttribute('aria-haspopup', 'menu');
  const more = el('span', 'widget-edit-more');
  more.innerHTML = MORE_ICON;
  layer.append(more);
  layer.addEventListener('click', () => openMenu(more, widget));
  section.append(layer);
}

export function addColumnTools(columnNode, dashboardId, columnId) {
  const add = el('button', 'column-add-widget', '＋ Add widget');
  add.type = 'button';
  add.setAttribute('aria-label', 'Add widget');
  add.addEventListener('click', () => {
    if (!canEditDashboards()) return toast(NO_EDIT_PERMISSION);
    openWidgetPicker(dashboardId, columnId);
  });
  columnNode.append(add);
}

export function initEditMode() {
  let addingColumn = false;
  $('add-column-button').addEventListener('click', async () => {
    if (addingColumn || !isEditing() || !state.dashboardId) return;
    if (!canEditDashboards()) return toast(NO_EDIT_PERMISSION);
    addingColumn = true;
    $('add-column-button').disabled = true;
    try {
      await addDashboardColumn(state.dashboardId);
    } catch (error) {
      toast(error.message);
    } finally {
      addingColumn = false;
      $('add-column-button').disabled = false;
    }
  });
  $('edit-button').addEventListener('click', () => {
    if (isEditing()) return setEditing(false);
    if (!canEditDashboards()) return toast(NO_EDIT_PERMISSION);
    setEditing(true);
  });
  document.addEventListener('click', (event) => {
    if (menu && !menu.contains(event.target) && !event.target.closest('.widget-edit')) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu) closeMenu();
  });
  // Also the board's own sideways scrolling.
  addEventListener('scroll', placeMenu, { capture: true, passive: true });
  addEventListener('resize', placeMenu);
  // A tablet put into kiosk mode leaves edit mode.
  new MutationObserver(() => {
    if (isKiosk() && isEditing()) setEditing(false);
  }).observe(document.documentElement, { attributeFilter: ['class'] });
}
