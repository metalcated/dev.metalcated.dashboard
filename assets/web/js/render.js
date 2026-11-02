// Renders the selected dashboard: columns of widgets, each mounted by its widget module. A change to the shown
// dashboard (updateBoard) only draws the widgets that changed; the others keep their section, and with it what they
// are doing (a page opened in a frame, a live stream), and are moved where they belong.

import { loadData } from './data.js';
import { $, el, note } from './dom.js';
import { addColumnTools, addEditTools } from './edit-mode.js';
import { fitBoard } from './fit.js';
import { state } from './state.js';
import { applyWidgetSize } from './widget-sizes.js';
import { WIDGETS, widgetTypeName } from './widgets/index.js';

// The board's widgets by id: the settings each was drawn with, its section and its cleanup. A highlight can lift one
// (highlight.js).
const drawn = new Map();
let drawnDashboardId = null;
let columnNodes = [];
let columnIds = [];

// Key order doesn't matter: Homey's answer to a change and its later announcement needn't list keys alike.
function sameJson(a, b) {
  const sorted = (value) => (Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
      : value);
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function dropWidget(id) {
  const entry = drawn.get(id);
  entry?.cleanup?.();
  entry?.section.remove();
  drawn.delete(id);
}

function teardown() {
  for (const id of [...drawn.keys()]) dropWidget(id);
  drawnDashboardId = null;
  columnNodes = [];
  columnIds = [];
}

let renderCount = 0;
let held = false;
let heldRender = false;

// While a highlight shows one of the board's own widgets, drawing the board again would replace that widget and lose
// what it is doing (a page opened in a frame, a live stream), so the board is drawn once it is let go.
export function holdBoard(hold) {
  held = hold;
  if (held || !heldRender) return;
  heldRender = false;
  renderDashboard();
}

// The board's own section for a widget, if it is drawn with these settings.
export function drawnWidget(dashboardId, widget) {
  const entry = dashboardId === drawnDashboardId ? drawn.get(widget.id) : null;
  return entry && sameJson(entry.widget, widget) ? entry.section : null;
}

// Moves a drawn section; where the browser can (moveBefore), without reloading the frames in it.
function place(parent, node, before) {
  if (node === before || (node.parentNode === parent && node.nextSibling === before)) return;
  try {
    if (parent.moveBefore) return parent.moveBefore(node, before);
  } catch {
    // Not movable this way (e.g. from another column in some browsers); insertBefore always works.
  }
  parent.insertBefore(node, before);
}

// Puts a column's sections in this order, moving as few as it can: the heaviest run already in order stays, a section
// with a frame or video counting most, as a browser without moveBefore reloads what it moves.
function arrange(parent, sections) {
  const children = [...parent.children];
  const at = sections.map((section) => (section.parentNode === parent ? children.indexOf(section) : -1));
  const weight = sections.map((section) => (section.querySelector('iframe, video') ? 100 : 1));
  const best = [];
  const previous = [];
  for (const [i] of sections.entries()) {
    best[i] = at[i] < 0 ? -1 : weight[i];
    previous[i] = -1;
    for (let j = 0; at[i] >= 0 && j < i; j += 1) {
      if (at[j] >= 0 && at[j] < at[i] && best[j] + weight[i] > best[i]) {
        best[i] = best[j] + weight[i];
        previous[i] = j;
      }
    }
  }
  const stay = new Set();
  for (let i = best.indexOf(Math.max(...best)); i >= 0 && best[i] >= 0; i = previous[i]) stay.add(sections[i]);
  const add = parent.querySelector('.column-add-widget');
  let next = add?.parentNode === parent ? add : null;
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (!stay.has(sections[i])) place(parent, sections[i], next);
    next = sections[i];
  }
}

function drawWidget(dashboardId, widget, parent, before) {
  const { section, cleanup } = renderWidget(widget, parent, before);
  const name = section.querySelector('.widget-title').textContent || WIDGETS[widget.type]?.title || widgetTypeName(widget.type);
  addEditTools(section, { dashboardId, widgetId: widget.id, name });
  drawn.set(widget.id, { widget, section, cleanup });
}

export async function renderDashboard() {
  const client = state.client;
  if (held) {
    heldRender = true;
    return;
  }
  const renderId = ++renderCount;
  teardown();
  const board = $('board');
  board.replaceChildren();

  const dashboard = state.dashboards[state.dashboardId];
  if (dashboard == null) {
    $('dashboard-name').textContent = 'Homey';
    note(board, 'No dashboards yet. Choose New dashboard to create your first one.');
    fitBoard();
    return;
  }
  $('dashboard-name').textContent = dashboard.name;
  document.title = `${dashboard.name} · Homey`;

  const columns = dashboard.columns ?? [];
  // The highlighted widget reads the same data, so keep loading what it needs.
  const widgets = [...columns.flatMap((column) => column.widgets), ...(state.highlighted ? [state.highlighted] : [])];
  const needed = widgets.flatMap((widget) => WIDGETS[widget.type]?.needs ?? []);
  const { data, errors } = await loadData(needed);
  if (renderId !== renderCount || state.client !== client) return; // Superseded by a render or connection.
  state.data = data;
  state.dataErrors = errors;

  drawnDashboardId = dashboard.id;
  for (const column of columns) {
    const columnNode = el('div', 'column');
    board.append(columnNode);
    columnNodes.push(columnNode);
    columnIds.push(column.id);
    for (const widget of column.widgets) drawWidget(dashboard.id, widget, columnNode, null);
    addColumnTools(columnNode, dashboard.id, column.id);
  }
  fitBoard();
}

// Brings the drawn board in line with the shown dashboard after it changed. Draws it all again when it is another
// dashboard, its columns changed or a widget needs data that wasn't loaded.
export function updateBoard() {
  const dashboard = state.dashboards[state.dashboardId];
  const columns = dashboard?.columns ?? [];
  const widgets = columns.flatMap((column) => column.widgets);
  const unloaded = widgets.flatMap((widget) => WIDGETS[widget.type]?.needs ?? [])
    .some((key) => state.data[key] == null && state.dataErrors[key] == null);
  if (held || dashboard == null || dashboard.id !== drawnDashboardId || unloaded) {
    renderDashboard();
    return;
  }
  $('dashboard-name').textContent = dashboard.name;
  document.title = `${dashboard.name} · Homey`;

  // Keep live sections mounted while columns change. Retire a column only after its widgets have moved.
  const previousColumns = [...columnNodes];
  if (columns.length !== columnNodes.length || columns.some((column, index) => column.id !== columnIds[index])) {
    const byId = new Map(columnIds.map((id, index) => [id, columnNodes[index]]));
    columnNodes = columns.map((column) => {
      const node = byId.get(column.id) ?? el('div', 'column');
      if (!node.parentNode) $('board').append(node);
      return node;
    });
    columnIds = columns.map((column) => column.id);
  }
  for (const [index, column] of columns.entries()) addColumnTools(columnNodes[index], dashboard.id, column.id);

  const shown = new Set(widgets.map((widget) => widget.id));
  for (const [id, entry] of drawn) {
    if (!shown.has(id) || !sameJson(entry.widget, widgets.find((widget) => widget.id === id))) dropWidget(id);
  }
  // Widgets still drawn are put in place first; new ones are then drawn where they belong.
  for (const [index, column] of columns.entries()) {
    arrange(columnNodes[index], column.widgets.filter((widget) => drawn.has(widget.id)).map((widget) => drawn.get(widget.id).section));
  }
  for (const [index, column] of columns.entries()) {
    let next = columnNodes[index].querySelector('.column-add-widget');
    for (const widget of [...column.widgets].reverse()) {
      if (!drawn.has(widget.id)) drawWidget(dashboard.id, widget, columnNodes[index], next);
      next = drawn.get(widget.id).section;
    }
  }
  for (const node of previousColumns) if (!columnNodes.includes(node)) node.remove();
  arrange($('board'), columnNodes);
  fitBoard();
}

// Display-size updates never remount widgets or camera/app frames.
export function refreshWidgetSizes(ids) {
  for (const [id, entry] of drawn) {
    if (ids == null || ids.includes(id)) applyWidgetSize(entry.section, id);
  }
}

// Draws these widgets again in their place, e.g. after the way an app widget runs changed (widget-modes.js).
export function redrawWidgets(ids) {
  for (const id of ids) {
    const entry = drawn.get(id);
    if (entry == null) continue;
    const { parentNode, nextSibling } = entry.section;
    dropWidget(id);
    drawWidget(drawnDashboardId, entry.widget, parentNode, nextSibling);
  }
}

// Also used for the highlight. Returns the widget's section and its cleanup, if it has one.
export function renderWidget(widget, parent, before = null) {
  const section = el('section', 'widget');
  section.dataset.widgetId = widget.id;
  section.dataset.dashboardId = state.dashboardId;
  const titleNode = el('h2', 'widget-title');
  const body = el('div', 'widget-body');
  section.append(titleNode, body);
  applyWidgetSize(section, widget.id);
  // Attach first: an iframe only gets a contentWindow once it is in the document.
  parent.insertBefore(section, before);

  const definition = WIDGETS[widget.type];
  const setTitle = (fallback) => {
    const title = widget.title ?? fallback;
    titleNode.textContent = title ?? '';
    titleNode.hidden = widget.titleHidden === true || !title;
  };
  setTitle(definition?.title);

  if (definition == null) {
    setTitle(widget.type);
    note(body, `The "${widget.type}" widget is only available in the Homey mobile app.`);
    return { section };
  }

  try {
    const cleanup = definition.mount({ widget, section, body, setTitle });
    return { section, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
  } catch (error) {
    note(body, error.message, true);
    return { section };
  }
}
