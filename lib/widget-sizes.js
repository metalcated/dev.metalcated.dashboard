'use strict';

// Web-only dimensions are separate from native dashboard definitions. Limits keep a settings/event map bounded
// even if a stored value is corrupt; ordinary entries are also filtered against the current native inventory.
const SETTINGS_KEY = 'widgetSizes';
const MAX_WIDGET_SIZES = 1024;
const GRID_UNIT = 20;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const validWidgetId = (id) => typeof id === 'string' && /^[\w-]{8,64}$/.test(id)
  && !['__proto__', 'prototype', 'constructor'].includes(id);

function failure(message, status = 400) {
  const error = new Error(message);
  error.status = error.statusCode = status;
  return error;
}

function normalizeSize(size) {
  if (size === null) return null;
  if (!object(size) || Object.keys(size).length !== 2 || !own(size, 'width') || !own(size, 'height')
      || !Number.isInteger(size.width) || size.width < 120 || size.width > 360 || size.width % GRID_UNIT !== 0
      || !Number.isInteger(size.height) || size.height < 80 || size.height > 1440 || size.height % GRID_UNIT !== 0) {
    throw failure('Choose a widget size on the 20-unit grid: width 120–360 and height 80–1440.');
  }
  return { width: size.width, height: size.height };
}

function widgetInventory(dashboards) {
  if (!object(dashboards)) throw failure('Homey could not confirm the dashboard widgets. Try again.', 502);
  const ids = new Set();
  for (const dashboard of Object.values(dashboards)) {
    if (!object(dashboard) || !Array.isArray(dashboard.columns)) throw failure('Homey returned an invalid dashboard layout.', 502);
    for (const column of dashboard.columns) {
      if (!object(column) || !Array.isArray(column.widgets)) throw failure('Homey returned an invalid dashboard layout.', 502);
      for (const widget of column.widgets) if (validWidgetId(widget?.id)) ids.add(widget.id);
    }
  }
  return ids;
}

function sanitizeSizes(saved, ids) {
  if (!object(saved)) return {};
  const clean = [];
  for (const [id, value] of Object.entries(saved)) {
    if (!validWidgetId(id) || !ids.has(id)) continue;
    let size;
    try { size = normalizeSize(value); } catch { continue; }
    if (size === null) continue;
    clean.push([id, size]);
    if (clean.length === MAX_WIDGET_SIZES) break;
  }
  return Object.fromEntries(clean);
}

module.exports = { SETTINGS_KEY, MAX_WIDGET_SIZES, GRID_UNIT, failure, validWidgetId, normalizeSize, widgetInventory, sanitizeSizes };
