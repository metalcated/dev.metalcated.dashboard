// Highlight: the "Highlight a widget" flow card shows one dashboard widget large or full screen on one screen (see
// screen.js) or every open one, over whatever it is showing, until a flow, its timer or someone at a screen closes it.
// Closing it on one screen closes it on every screen showing it. The app keeps what each screen highlights and
// announces each change. When the screen shows the widget's dashboard, the board's own widget is lifted over the page
// (a popover, so it isn't moved and keeps what it is doing: a page opened in a frame, a live stream) and the board isn't
// drawn again until it closes; otherwise this page mounts a copy like the board does. Either way it is laid out at the
// usual column width and zoomed to fit (media widgets marked `fill` stretch to the screen instead). Not the browser's
// full-screen mode: that needs a tap. Only when served by the app.

import { APP_ID, servedByHomey } from './config.js';
import { loadData } from './data.js';
import { $, el } from './dom.js';
import { CLOSE_ICON } from './icons.js';
import { subscribe } from './realtime.js';
import { drawnWidget, holdBoard, renderWidget } from './render.js';
import { screenId } from './screen.js';
import { state } from './state.js';
import { WIDGETS } from './widgets/index.js';

const MAX_ZOOM = 2.5;

const backdrop = $('highlight-backdrop');
const holder = $('highlight-holder');
const closeButton = el('button', 'sheet-close highlight-close');
closeButton.type = 'button';
closeButton.setAttribute('aria-label', 'Close');

let current = null; // What the app says this screen shows: { id, target, dashboardId, widgetId, name, size } or null.
// On screen: { key, section, live, placeholder, cleanup }. The key is the widget and size, so an unchanged widget isn't
// shown again; live is the board's own widget, held in its column by the placeholder, rather than a copy.
let shown = null;
let generation = 0;

const resizes = new ResizeObserver(() => fit());

function findWidget({ dashboardId, widgetId }) {
  return (state.dashboards[dashboardId]?.columns ?? [])
    .flatMap((column) => column.widgets)
    .find((widget) => widget.id === widgetId) ?? null;
}

// Puts the board's own widget back in its column, or removes the copy.
function drop() {
  if (shown == null) return;
  const { section, live, placeholder, cleanup } = shown;
  shown = null;
  state.highlighted = null;
  resizes.unobserve(section);
  closeButton.remove();
  if (section.matches(':popover-open')) section.hidePopover();
  if (live) {
    section.removeAttribute('popover');
    section.classList.remove('highlight', 'is-fullscreen', 'is-fill');
    section.style.zoom = '';
    section.style.removeProperty('--unzoom');
    placeholder.remove();
  } else {
    cleanup?.();
    section.remove();
  }
}

function hide() {
  generation++;
  drop();
  if (backdrop.matches(':popover-open')) backdrop.hidePopover();
  holdBoard(false);
}

export function isHighlightOpen() {
  return shown != null;
}

// Zooms the widget to the room the window leaves: a large highlight keeps a margin around it, a full-screen one doesn't.
// The board's own widget is already zoomed with the board when that fits the window's width (fit.js), and --unzoom
// keeps the padding and the close button at their usual size.
function fit() {
  if (shown == null) return;
  const { section, live } = shown;
  const outer = live ? parseFloat($('board').style.zoom) || 1 : 1;
  section.style.zoom = '';
  section.style.removeProperty('--unzoom');
  let zoom = 1;
  if (!section.classList.contains('is-fill') || !section.classList.contains('is-fullscreen')) {
    const style = getComputedStyle(section);
    const [top, right, bottom, left] = ['Top', 'Right', 'Bottom', 'Left'].map((side) => parseFloat(style[`padding${side}`]));
    const width = parseFloat(style.width);
    // The offset size may be scaled by the board's zoom, so only its proportions are used.
    const height = (width + left + right) * (section.offsetHeight / section.offsetWidth) - top - bottom;
    const room = section.classList.contains('is-fullscreen') ? 1 : 0.94;
    zoom = Math.min(MAX_ZOOM, (innerWidth * room - left - right) / width, (innerHeight * room - top - bottom) / Math.max(1, height));
    if (Math.abs(zoom - 1) <= 0.01) zoom = 1;
  }
  if (zoom !== 1) section.style.setProperty('--unzoom', String(1 / zoom));
  if (zoom / outer !== 1) section.style.zoom = String(zoom / outer);
}

// Shows what the app says is highlighted, once the dashboards it is on have loaded. Called again whenever they change.
export async function showHighlight() {
  const client = state.client;
  const highlight = current;
  const widget = highlight && findWidget(highlight);
  if (widget == null) {
    if (highlight && Object.keys(state.dashboards).length > 0) console.info(`Highlight: ${highlight.name} isn't on its dashboard`);
    hide();
    return;
  }
  const definition = WIDGETS[widget.type];
  const key = JSON.stringify([highlight.size, widget]);
  if (key === shown?.key) return;

  const run = ++generation;
  let live = drawnWidget(highlight.dashboardId, widget);
  const missing = live ? [] : (definition?.needs ?? []).filter((need) => state.data[need] == null);
  if (missing.length > 0) {
    const { data, errors } = await loadData(missing);
    if (run !== generation || state.client !== client) return; // Replaced, closed or reconnected meanwhile.
    Object.assign(state.data, data);
    Object.assign(state.dataErrors, errors);
    live = drawnWidget(highlight.dashboardId, widget);
  }

  drop();
  if (live) {
    const placeholder = el('div');
    placeholder.style.height = getComputedStyle(live).height;
    live.before(placeholder);
    shown = { key, section: live, live: true, placeholder };
  } else {
    state.highlighted = widget;
    const { section, cleanup } = renderWidget(widget, holder);
    shown = { key, section, live: false, cleanup };
  }
  holdBoard(shown.live);

  const { section } = shown;
  for (const node of [backdrop, section]) {
    node.classList.toggle('is-fullscreen', highlight.size === 'fullscreen');
    node.classList.toggle('is-fill', definition?.fill === true);
  }
  // In this order: what is shown later is drawn on top.
  if (!backdrop.matches(':popover-open')) backdrop.showPopover();
  section.classList.add('highlight');
  section.append(closeButton);
  section.setAttribute('popover', 'manual');
  section.showPopover();
  resizes.observe(section);
  fit();
}

function setCurrent(highlight) {
  current = highlight ?? null;
  showHighlight();
}

// On load and after reconnecting: the app may have changed it while this page wasn't listening.
export async function fetchHighlight() {
  if (!servedByHomey) return;
  const client = state.client;
  try {
    const query = screenId() ? `?screen=${encodeURIComponent(screenId())}` : '';
    const { highlight } = await client.api('GET', `/api/app/${APP_ID}/highlight${query}`);
    if (state.client === client) setCurrent(highlight);
  } catch (error) {
    console.info(`Highlight: ${error.message}`);
  }
}

// Closed on this screen: the app closes it on the others and runs the "closed" flows.
function closeEverywhere() {
  const closed = current;
  current = null;
  hide();
  if (closed == null) return;
  state.client.api('POST', `/api/app/${APP_ID}/highlight/close`, { token: state.client.token, id: closed.id })
    .catch((error) => console.info(`Highlight: closing failed: ${error.message}`));
}

// Needs the client and the realtime connection.
export function watchHighlight() {
  if (!servedByHomey) return;
  const client = state.client;
  closeButton.innerHTML = CLOSE_ICON;
  closeButton.addEventListener('click', closeEverywhere);
  // Unless a sheet opened from the widget is on top: Escape closes that.
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && shown != null && document.querySelector('dialog[open]') == null) closeEverywhere();
  });
  // A tap on the dimmed dashboard around a large highlight.
  backdrop.addEventListener('click', closeEverywhere);
  // Re-fit when the window changes; the observer does when the widget's content settles (a picture loads).
  addEventListener('resize', fit);

  // Every screen's highlight; a browser without a screen id shows the one for all screens.
  subscribe(`homey:app:${APP_ID}`, 'highlight', (data) => {
    if (state.client === client) setCurrent(data?.highlights?.[screenId() ?? 'all']);
  });
  fetchHighlight();
}
