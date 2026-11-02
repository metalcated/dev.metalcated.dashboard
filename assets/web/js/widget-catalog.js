// Native widget data keys are shared with their existing renderers and settings editor.
// Widgets stay native Homey layout entries; this catalogue does not introduce a second layout format.
export const WIDGET_CATALOG = [
  ['devices_favorites', 'Favorite devices', 'Devices'],
  ['devices_custom', 'Devices', 'Devices', { deviceIds: [] }],
  ['light_device', 'Light', 'Devices'],
  ['light_group', 'Lights', 'Devices', { lightIds: [] }],
  ['thermostat', 'Thermostat', 'Devices'],
  ['device_speaker_large', 'Speaker', 'Devices'],
  ['device_speaker_small', 'Compact speaker', 'Devices'],
  ['device_camera_live', 'Live camera', 'Cameras', { autoplay: false }],
  ['device_camera_snapshot', 'Camera snapshot', 'Cameras'],
  ['flows_favorites', 'Favorite Flows', 'Flows and Moods'],
  ['flows_custom', 'Flows', 'Flows and Moods', { flowIds: [] }],
  ['moods_favorites', 'Favorite Moods', 'Flows and Moods'],
  ['moods_custom', 'Moods', 'Flows and Moods', { moodIds: [] }],
  ['devices_zone', 'Zone devices', 'Zones'],
  ['moods_zone', 'Zone Moods', 'Zones'],
  ['light_zones', 'Zone lights', 'Zones'],
  ['zone_controls', 'Zone controls', 'Zones', { controls: [] }],
  ['sensors_selection', 'Sensors', 'Status', { capabilitiesIds: [] }],
  ['batteries_devices', 'Batteries', 'Status', { deviceIds: [] }],
  ['batteries_device_low', 'Low batteries', 'Status'],
  ['energy_usage', 'Energy', 'Status'],
  ['energy_dynamic_prices', 'Electricity prices', 'Status'],
  ['insights_chart_line', 'Chart', 'Status', { resolution: 'last24Hours', scale: 'hour' }],
  ['logic_variables', 'Variables', 'Status', { variableIds: [] }],
  ['notifications_timeline_large', 'Timeline', 'Status', { excluded: [] }],
  ['notifications_timeline_small', 'Compact timeline', 'Status', { excluded: [] }],
  ['weather', 'Weather', 'Status'],
  ['weather_forecast', 'Weather forecast', 'Status'],
  ['users_avatars', 'Users', 'Status'],
  ['dashboards_shortcuts', 'Dashboards', 'Other', { dashboardIds: [] }],
  ['note', 'Note', 'Other', { color: 'yellow' }],
  ['web_frame', 'Web frame', 'Other'],
].map(([type, name, group, data = {}]) => Object.freeze({ type, name, group, data: Object.freeze(data) }));

// randomUUID is unavailable over plain HTTP on local Homey, so use the browser's cryptographic bytes there too.
export function widgetId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createWidgetDraft(entry) {
  return {
    id: widgetId(),
    type: entry.type,
    title: entry.name,
    titleHidden: false,
    titleModified: false,
    data: structuredClone(entry.data ?? {}),
  };
}

export function appWidgetEntries(definitions) {
  return Object.values(definitions ?? {}).filter((definition) => typeof definition?.id === 'string'
    && definition.ownerUri?.startsWith('homey:app:') && typeof definition.ownerId === 'string' && definition.deprecated !== true)
    .map((definition) => ({
      type: 'app_webview', name: definition.name ?? definition.ownerId, group: 'App widgets',
      data: {
        appWidgetId: definition.id,
        deviceIds: [],
        settings: Object.fromEntries((definition.settings ?? []).filter((setting) => setting?.id && setting.value !== undefined)
          .map((setting) => [setting.id, structuredClone(setting.value)])),
      },
    }));
}
