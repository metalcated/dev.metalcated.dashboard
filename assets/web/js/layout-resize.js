// Corner resizing changes only web presentation. Native widget types/data and running media stay untouched.
import { canEditDashboards } from './dashboard-save.js';
import { el, toast } from './dom.js';
import { state } from './state.js';
import { WEB_COLUMN_UNITS, WEB_SIZE_STEP, applyWidgetSize, normalizeWidgetSize, saveWidgetSize, widgetSize } from './widget-sizes.js';

const HANDLE = '.widget-resize-handle';
const WIDGET = '.widget[data-widget-id]';
const COLUMN = '.column[data-column-id]';
const activationKeys = new Set([' ', 'Enter']);
const same = (left, right) => left?.width === right?.width && left?.height === right?.height;

export function initLayoutResize({ isEditing, board = document.getElementById('board'), onStart = () => {} } = {}) {
  if (!board || typeof isEditing !== 'function') throw new Error('The dashboard editor is unavailable.');
  let active = null;
  let saving = false;
  let frame = null;
  let disposed = false;
  const live = document.getElementById('layout-resize-status') ?? el('div', 'layout-resize-status');
  const ownsLive = !live.isConnected;
  live.id = 'layout-resize-status';
  live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
  if (ownsLive) document.body.append(live);
  const announce = (message) => { live.textContent = message; };
  const contentWidth = (column) => {
    const addWidth = column.querySelector('.column-add-widget')?.getBoundingClientRect().width;
    if (addWidth > 0) return addWidth;
    const box = column.getBoundingClientRect();
    const style = window.getComputedStyle?.(column);
    const inset = (name) => Number.parseFloat(style?.[name]) || 0;
    return box.width - inset('paddingLeft') - inset('paddingRight') - inset('borderLeftWidth') - inset('borderRightWidth');
  };
  const current = () => active && !disposed && isEditing() && canEditDashboards() && !state.highlighted
    && !document.querySelector('dialog[open]') && state.client === active.client && state.dashboardId === active.dashboardId
    && active.source.isConnected && active.handle.isConnected && active.source.closest(COLUMN)?.dataset.columnId === active.columnId
    && state.dashboards[active.dashboardId]?.columns.some((column) => column.id === active.columnId
      && column.widgets.some((widget) => widget.id === active.widgetId))
    && same(widgetSize(active.widgetId), active.saved);

  function cleanup(restore = true) {
    const previous = active;
    active = null;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (!previous) return null;
    previous.source.classList.remove('is-layout-resizing');
    previous.handle.setAttribute('aria-pressed', 'false');
    previous.label?.remove();
    document.body.classList.remove('layout-resize-active');
    if (restore) applyWidgetSize(previous.source, previous.widgetId);
    try {
      if (previous.pointerId != null && previous.handle.hasPointerCapture?.(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
    } catch { /* A removed handle may already have released pointer capture. */ }
    return previous;
  }
  function cancel(message = 'Resize cancelled.', { focus = true } = {}) {
    if (!active) return;
    const previous = cleanup();
    announce(message);
    if (focus && previous.handle.isConnected) previous.handle.focus({ preventScroll: true });
  }

  function preview(size, speak = false) {
    if (!active) return;
    active.size = normalizeWidgetSize(size);
    applyWidgetSize(active.source, active.widgetId, active.size);
    const scale = contentWidth(active.column) / WEB_COLUMN_UNITS;
    const dimensions = `${Math.round(active.size.width * scale)} × ${Math.round(active.size.height * scale)} px`;
    active.label.textContent = dimensions;
    active.label.style.left = `${Math.max(8, Math.min(active.x + 16, window.innerWidth - 180))}px`;
    active.label.style.top = `${Math.max(8, Math.min(active.y + 16, window.innerHeight - 48))}px`;
    if (speak) announce(`${active.name}, ${dimensions}. Use arrows to resize, Space or Enter to save, Escape to cancel.`);
  }
  function lift() {
    active.started = true;
    active.source.classList.add('is-layout-resizing');
    active.handle.setAttribute('aria-pressed', 'true');
    document.body.classList.add('layout-resize-active');
    active.label = el('div', 'layout-resize-label');
    active.label.setAttribute('aria-hidden', 'true');
    document.body.append(active.label);
    if (active.mode === 'keyboard') preview(active.size, true);
    else tick();
  }
  function pointerSize() {
    const box = active.column.getBoundingClientRect();
    // Column movement accounts for scrolling while the pointer remains at a viewport edge.
    return {
      width: active.baseline.width + (active.x - active.startX + active.columnLeft - box.left) * active.unitsPerPixel,
      height: active.baseline.height + (active.y - active.startY + active.columnTop - box.top) * active.unitsPerPixel,
    };
  }
  function tick() {
    frame = null;
    if (!active?.started || active.mode !== 'pointer') return;
    if (!current()) return cancel();
    const box = board.getBoundingClientRect();
    const left = Math.max(box.left, 0), right = Math.min(box.right, window.innerWidth);
    if (active.x >= left && active.x <= right) {
      if (active.y > window.innerHeight - 36) window.scrollBy(0, 12);
      else if (active.y < 64) window.scrollBy(0, -12);
    }
    if (active.y >= Math.max(box.top, 0) && active.y <= Math.min(box.bottom, window.innerHeight)) {
      if (active.x >= right - 32 && active.x <= right) board.scrollLeft += 16;
      else if (active.x <= left + 32 && active.x >= left) board.scrollLeft -= 16;
    }
    preview(pointerSize());
    frame = window.requestAnimationFrame(tick);
  }

  function start(handle, mode, event) {
    if (active || saving || disposed || !isEditing() || !canEditDashboards() || !state.client || state.highlighted
        || document.querySelector('dialog[open]') || !board.contains(handle)) return false;
    const source = handle.closest(WIDGET), column = source?.closest(COLUMN);
    if (!source || !column || source.dataset.dashboardId !== state.dashboardId) return false;
    const known = state.dashboards[state.dashboardId]?.columns.find((item) => item.id === column.dataset.columnId)
      ?.widgets.some((widget) => widget.id === source.dataset.widgetId);
    if (!known) return false;
    onStart();
    const bounds = column.getBoundingClientRect();
    const width = contentWidth(column);
    const body = source.querySelector('.widget-body')?.getBoundingClientRect() ?? source.getBoundingClientRect();
    if (!(width > 0)) return false;
    const unitsPerPixel = WEB_COLUMN_UNITS / width;
    const saved = widgetSize(source.dataset.widgetId);
    const baseline = saved ?? normalizeWidgetSize({ width: source.getBoundingClientRect().width * unitsPerPixel, height: body.height * unitsPerPixel });
    active = { handle, source, column, columnId: column.dataset.columnId, columnLeft: bounds.left, columnTop: bounds.top,
      client: state.client, dashboardId: state.dashboardId, widgetId: source.dataset.widgetId,
      name: source.querySelector('.widget-title')?.textContent?.trim() || 'Widget',
      mode, saved, baseline, size: { ...baseline }, unitsPerPixel, started: false,
      startX: event.clientX, startY: event.clientY, x: event.clientX ?? bounds.right, y: event.clientY ?? body.bottom,
      pointerId: mode === 'pointer' ? event.pointerId : null };
    handle.focus({ preventScroll: true });
    if (mode === 'pointer') {
      try { handle.setPointerCapture(event.pointerId); } catch { /* Mouse document handlers still work without capture. */ }
    } else lift();
    return true;
  }

  async function finish() {
    if (!active) return;
    if (!current()) return cancel();
    if (!active.started || same(active.size, active.baseline)) return cancel('Widget kept at its current size.');
    const previous = cleanup(false);
    saving = true;
    announce(`Saving ${previous.name} size…`);
    try {
      await saveWidgetSize(previous.widgetId, previous.size);
      if (disposed || state.client !== previous.client || state.dashboardId !== previous.dashboardId) return;
      applyWidgetSize(previous.source, previous.widgetId);
      announce(`${previous.name} resized for the web.`);
      if (previous.handle.isConnected) previous.handle.focus({ preventScroll: true });
    } catch (error) {
      if (!disposed && state.client === previous.client && state.dashboardId === previous.dashboardId) {
        applyWidgetSize(previous.source, previous.widgetId);
        announce(error.message); toast(error.message);
        if (previous.handle.isConnected) previous.handle.focus({ preventScroll: true });
      }
    } finally { saving = false; }
  }

  function pointerDown(event) {
    const handle = event.target.closest?.(HANDLE);
    if (handle && event.button === 0 && event.isPrimary !== false && start(handle, 'pointer', event)) {
      event.preventDefault(); event.stopPropagation();
    }
  }
  function pointerMove(event) {
    if (active?.mode !== 'pointer' || event.pointerId !== active.pointerId) return;
    if (!current()) return cancel();
    event.preventDefault(); active.x = event.clientX; active.y = event.clientY;
    if (!active.started && Math.hypot(active.x - active.startX, active.y - active.startY) >= 6) lift();
    else if (active.started) preview(pointerSize());
  }
  function pointerUp(event) {
    if (active?.mode !== 'pointer' || event.pointerId !== active.pointerId) return;
    event.preventDefault(); active.x = event.clientX; active.y = event.clientY;
    if (active.started && current()) preview(pointerSize());
    return finish();
  }
  function pointerCancel(event) {
    if (active?.mode === 'pointer' && event.pointerId === active.pointerId) cancel();
  }
  function keyDown(event) {
    if (active && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    const handle = event.target.closest?.(HANDLE);
    if (!active) {
      if (handle && activationKeys.has(event.key) && start(handle, 'keyboard', event)) event.preventDefault();
      return;
    }
    if (active.mode !== 'keyboard') return;
    if (event.key === 'Tab' || handle !== active.handle) { cancel('Resize cancelled.', { focus: false }); return; }
    if (!current()) return cancel();
    if (activationKeys.has(event.key)) { event.preventDefault(); return finish(); }
    const delta = { ArrowLeft: [-WEB_SIZE_STEP, 0], ArrowRight: [WEB_SIZE_STEP, 0], ArrowUp: [0, -WEB_SIZE_STEP], ArrowDown: [0, WEB_SIZE_STEP] }[event.key];
    if (!delta) return;
    event.preventDefault();
    preview({ width: active.size.width + delta[0], height: active.size.height + delta[1] }, true);
  }
  const click = (event) => { if (event.target.closest?.(HANDLE)) { event.preventDefault(); event.stopPropagation(); } };
  const onBlur = () => cancel('Resize cancelled.', { focus: false });
  const onVisibility = () => { if (document.visibilityState === 'hidden') onBlur(); };
  const onWindowResize = () => cancel();
  const handlers = [['pointerdown', pointerDown], ['pointermove', pointerMove], ['pointerup', pointerUp],
    ['pointercancel', pointerCancel], ['lostpointercapture', pointerCancel], ['keydown', keyDown], ['click', click], ['visibilitychange', onVisibility]];
  for (const [type, handler] of handlers) document.addEventListener(type, handler, { capture: true, passive: false });
  window.addEventListener('blur', onBlur); window.addEventListener('resize', onWindowResize);
  const observer = new MutationObserver(() => { if (active && !current()) cancel('Resize cancelled.', { focus: !document.querySelector('dialog[open]') }); });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'style'] });
  return { cancel, isResizing: () => active != null, destroy() {
    cancel(); disposed = true; observer.disconnect();
    for (const [type, handler] of handlers) document.removeEventListener(type, handler, { capture: true });
    window.removeEventListener('blur', onBlur); window.removeEventListener('resize', onWindowResize);
    if (ownsLive) live.remove();
  } };
}
