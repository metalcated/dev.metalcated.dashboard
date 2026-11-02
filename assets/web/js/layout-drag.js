// Dragging chooses a native column and insertion point. Widgets and their media remain in place until saved.
import { canEditDashboards, moveDashboardWidget } from './dashboard-save.js';
import { el, toast } from './dom.js';
import { state } from './state.js';

const HANDLE = '.widget-drag-handle';
const WIDGET = '.widget[data-widget-id]';
const COLUMN = '.column[data-column-id]';
const activationKeys = new Set([' ', 'Enter']);

export function initLayoutDrag({ isEditing, moveWidget = moveDashboardWidget, board = document.getElementById('board') } = {}) {
  if (!board || typeof isEditing !== 'function') throw new Error('The dashboard editor is unavailable.');
  let active = null;
  let saving = false;
  let disposed = false;
  let frame = null;
  const live = document.getElementById('layout-drag-status') ?? el('div', 'layout-drag-status');
  const ownsLive = !live.isConnected;
  live.id = 'layout-drag-status';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  if (ownsLive) document.body.append(live);
  const announce = (message) => { live.textContent = message; };
  const columns = () => state.dashboards[state.dashboardId]?.columns ?? [];
  const findWidget = (id) => columns().flatMap((column) => column.widgets ?? []).find((widget) => widget.id === id);
  const widgetNodes = (column) => [...column.querySelectorAll(WIDGET)].filter((node) => node.dataset.dashboardId === state.dashboardId);
  const columnNodes = () => [...board.querySelectorAll(COLUMN)];
  const nodeFor = (id) => columnNodes().find((node) => node.dataset.columnId === id);
  const current = () => active && !disposed && isEditing() && canEditDashboards() && !state.highlighted
    && !document.querySelector('dialog[open]')
    && state.client === active.client && state.dashboardId === active.dashboardId
    && active.source.isConnected && active.handle.isConnected && findWidget(active.widgetId);

  function cleanup() {
    const previous = active;
    active = null;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (!previous) return null;
    previous.source.classList.remove('is-layout-dragging');
    previous.handle.setAttribute('aria-pressed', 'false');
    previous.targetNode?.classList.remove('is-layout-drop-target');
    previous.ghost?.remove();
    previous.marker?.remove();
    document.body.classList.remove('layout-drag-active');
    try {
      if (previous.pointerId != null && previous.handle.hasPointerCapture?.(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
    } catch { /* A removed handle may already have released pointer capture. */ }
    return previous;
  }

  function cancel(message = 'Move cancelled.', { focus = true } = {}) {
    if (!active) return;
    const previous = cleanup();
    announce(message);
    if (focus && previous?.handle.isConnected) previous.handle.focus({ preventScroll: true });
  }

  function targetPosition(target) {
    const column = columns().find((candidate) => candidate.id === target?.columnId);
    if (!column) return null;
    const items = column.widgets.filter((widget) => widget.id !== active.widgetId);
    const index = target.beforeWidgetId == null ? items.length : items.findIndex((widget) => widget.id === target.beforeWidgetId);
    return index < 0 ? null : { column, items, index };
  }

  function paintTarget(target, speak = false) {
    if (!active) return;
    active.target = target;
    const position = targetPosition(target);
    const columnNode = position && nodeFor(target.columnId);
    if (active.targetNode !== columnNode) {
      active.targetNode?.classList.remove('is-layout-drop-target');
      active.targetNode = columnNode ?? null;
      columnNode?.classList.add('is-layout-drop-target');
    }
    if (!columnNode) {
      if (active.marker) active.marker.hidden = true;
      return;
    }
    const box = columnNode.getBoundingClientRect();
    const before = widgetNodes(columnNode).find((node) => node.dataset.widgetId === target.beforeWidgetId);
    const last = widgetNodes(columnNode).filter((node) => node.dataset.widgetId !== active.widgetId).at(-1);
    const add = columnNode.querySelector('.column-add-widget');
    const top = before ? before.getBoundingClientRect().top - 10
      : add ? add.getBoundingClientRect().top - 12
        : last ? last.getBoundingClientRect().bottom + 10 : box.top + 12;
    active.marker.style.left = `${box.left}px`;
    active.marker.style.top = `${top}px`;
    active.marker.style.width = `${box.width}px`;
    active.marker.hidden = false;
    if (speak) announce(`Column ${columns().indexOf(position.column) + 1}, position ${position.index + 1}. Use arrows to move, Space or Enter to save, Escape to cancel.`);
  }

  function hitTest(x, y) {
    const bounds = board.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom
        || x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight) return null;
    // Gaps between columns belong to the nearest column, so every valid drop snaps to the native layout.
    const choices = columnNodes().map((node) => ({ node, box: node.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0 && box.right > bounds.left && box.left < bounds.right);
    choices.sort((a, b) => Math.max(a.box.left - x, x - a.box.right, 0) - Math.max(b.box.left - x, x - b.box.right, 0));
    const column = choices[0]?.node;
    if (!column || !columns().some((candidate) => candidate.id === column.dataset.columnId)) return null;
    const before = widgetNodes(column).filter((node) => node.dataset.widgetId !== active.widgetId)
      .find((node) => { const box = node.getBoundingClientRect(); return y < box.top + box.height / 2; });
    return { columnId: column.dataset.columnId, beforeWidgetId: before?.dataset.widgetId ?? null };
  }

  function lift() {
    active.started = true;
    active.source.classList.add('is-layout-dragging');
    active.handle.setAttribute('aria-pressed', 'true');
    document.body.classList.add('layout-drag-active');
    active.ghost = el('div', 'layout-drag-ghost', active.name);
    active.ghost.setAttribute('aria-hidden', 'true');
    active.marker = el('div', 'layout-drop-marker');
    active.marker.setAttribute('aria-hidden', 'true');
    document.body.append(active.ghost, active.marker);
    if (active.mode === 'keyboard') {
      active.ghost.hidden = true;
      paintTarget(active.target, true);
    } else {
      announce(`Moving ${active.name}. Drop into a column, or press Escape to cancel.`);
      tick();
    }
  }

  function paintPointer() {
    active.ghost.style.left = `${Math.max(8, Math.min(active.x + 16, window.innerWidth - 160))}px`;
    active.ghost.style.top = `${Math.min(active.y + 16, window.innerHeight - 48)}px`;
    paintTarget(hitTest(active.x, active.y));
  }

  function tick() {
    frame = null;
    if (!active || active.mode !== 'pointer' || !active.started) return;
    if (!current()) return cancel();
    const box = board.getBoundingClientRect();
    const right = Math.min(box.right, window.innerWidth);
    const left = Math.max(box.left, 0);
    if (active.y >= box.top && active.y <= Math.min(box.bottom, window.innerHeight)) {
      if (active.x >= right - 32 && active.x <= right) board.scrollLeft += 16;
      else if (active.x <= left + 32 && active.x >= left) board.scrollLeft -= 16;
    }
    if (active.x >= left && active.x <= right) {
      if (active.y > window.innerHeight - 36) window.scrollBy(0, 12);
      else if (active.y < 64) window.scrollBy(0, -12);
    }
    paintPointer();
    frame = window.requestAnimationFrame(tick);
  }

  function start(handle, mode, event) {
    if (active || saving || disposed || !isEditing() || !canEditDashboards() || !state.client || state.highlighted
        || document.querySelector('dialog[open]') || !board.contains(handle)) return false;
    const source = handle.closest(WIDGET);
    const column = source?.closest(COLUMN);
    if (!source || !column || source.dataset.dashboardId !== state.dashboardId) return false;
    const nativeColumn = columns().find((candidate) => candidate.id === column.dataset.columnId);
    const index = nativeColumn?.widgets.findIndex((widget) => widget.id === source.dataset.widgetId) ?? -1;
    if (index < 0) return false;
    active = {
      mode, handle, source, client: state.client, dashboardId: state.dashboardId, widgetId: source.dataset.widgetId,
      name: source.querySelector('.widget-title')?.textContent?.trim() || 'Widget',
      target: { columnId: nativeColumn.id, beforeWidgetId: nativeColumn.widgets[index + 1]?.id ?? null },
      started: false, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
      pointerId: mode === 'pointer' ? event.pointerId : null,
    };
    handle.focus({ preventScroll: true });
    if (mode === 'pointer') {
      try { handle.setPointerCapture(event.pointerId); } catch { /* Document handlers still work for mouse pointers. */ }
    } else lift();
    return true;
  }

  async function finish() {
    if (!active) return;
    if (!current()) return cancel();
    const position = active.started && targetPosition(active.target);
    const from = columns().find((column) => column.widgets.some((widget) => widget.id === active.widgetId));
    const currentIndex = from?.widgets.findIndex((widget) => widget.id === active.widgetId) ?? -1;
    const unchanged = position && from.id === position.column.id && currentIndex === position.index;
    if (!position || unchanged) return cancel(unchanged ? 'Widget kept in its current position.' : 'Move cancelled.');
    const previous = cleanup();
    saving = true;
    announce(`Saving ${previous.name}…`);
    try {
      await moveWidget(previous.dashboardId, previous.widgetId, previous.target.columnId, previous.target.beforeWidgetId);
      if (disposed || state.client !== previous.client || state.dashboardId !== previous.dashboardId) return;
      announce(`${previous.name} moved.`);
      const moved = [...board.querySelectorAll(WIDGET)].find((node) => node.dataset.widgetId === previous.widgetId);
      moved?.querySelector(HANDLE)?.focus({ preventScroll: true });
    } catch (error) {
      if (!disposed && state.client === previous.client && state.dashboardId === previous.dashboardId) {
        announce(error.message);
        toast(error.message);
        previous.handle.isConnected && previous.handle.focus({ preventScroll: true });
      }
    } finally { saving = false; }
  }

  function pointerDown(event) {
    const handle = event.target.closest?.(HANDLE);
    if (!handle || event.button !== 0 || event.isPrimary === false) return;
    if (start(handle, 'pointer', event)) { event.preventDefault(); event.stopPropagation(); }
  }
  function pointerMove(event) {
    if (!active || active.mode !== 'pointer' || event.pointerId !== active.pointerId) return;
    if (!current()) return cancel();
    event.preventDefault();
    active.x = event.clientX; active.y = event.clientY;
    if (!active.started && Math.hypot(active.x - active.startX, active.y - active.startY) >= 6) lift();
    else if (active.started) paintPointer();
  }
  function pointerUp(event) {
    if (active?.mode !== 'pointer' || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    // Re-hit-test the release position, rather than saving the previous move's target.
    active.x = event.clientX; active.y = event.clientY;
    if (active.started && current()) paintPointer();
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
    if (event.key === 'Tab' || handle !== active.handle) { cancel('Move cancelled.', { focus: false }); return; }
    if (!current()) return cancel();
    if (activationKeys.has(event.key)) { event.preventDefault(); return finish(); }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const position = targetPosition(active.target);
    if (!position) return cancel();
    let column = position.column;
    let index = position.index;
    if (event.key === 'ArrowUp') index -= 1;
    if (event.key === 'ArrowDown') index += 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const next = columns().indexOf(column) + (event.key === 'ArrowLeft' ? -1 : 1);
      column = columns()[next] ?? column;
    }
    const items = column.widgets.filter((widget) => widget.id !== active.widgetId);
    index = Math.max(0, Math.min(index, items.length));
    nodeFor(column.id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    paintTarget({ columnId: column.id, beforeWidgetId: items[index]?.id ?? null }, true);
  }
  const suppressClick = (event) => {
    if (event.target.closest?.(HANDLE)) { event.preventDefault(); event.stopPropagation(); }
  };
  const onScroll = () => {
    if (!active?.started) return;
    if (!current()) return cancel();
    if (active.mode === 'pointer') paintPointer(); else paintTarget(active.target);
  };
  const onVisibility = () => { if (document.visibilityState === 'hidden') cancel('Move cancelled.', { focus: false }); };
  const onBlur = () => cancel('Move cancelled.', { focus: false });
  const listeners = [
    ['pointerdown', pointerDown], ['pointermove', pointerMove], ['pointerup', pointerUp],
    ['pointercancel', pointerCancel], ['lostpointercapture', pointerCancel], ['keydown', keyDown],
    ['click', suppressClick], ['scroll', onScroll], ['visibilitychange', onVisibility],
  ];
  for (const [type, handler] of listeners) document.addEventListener(type, handler, { capture: true, passive: false });
  window.addEventListener('blur', onBlur);
  const observer = new MutationObserver(() => { if (active && !current()) cancel(); });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  return {
    cancel,
    isDragging: () => active != null,
    destroy() {
      cancel(); disposed = true; observer.disconnect();
      for (const [type, handler] of listeners) document.removeEventListener(type, handler, { capture: true });
      window.removeEventListener('blur', onBlur);
      if (ownsLive) live.remove();
    },
  };
}
