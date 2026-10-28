// Device helpers: icons, status text, live capability updates and setting capabilities.

import { requireData } from './data.js';
import { el, note, toast } from './dom.js';
import { FALLBACK_DEVICE_ICON } from './icons.js';
import { subscribe } from './realtime.js';
import { state } from './state.js';

export function formatCapability(capability) {
  if (capability == null || capability.value == null) return '';
  const { value, units, decimals, min, max } = capability;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') {
    if (max === 1 && (units == null || units === '%') && (min === 0 || min == null)) return `${Math.round(value * 100)} %`;
    const rounded = Number(value.toFixed(Math.min(decimals ?? 1, 2)));
    return units ? `${rounded} ${units}` : String(rounded);
  }
  return String(value);
}

export function quickActionCapability(device) {
  const capability = device.capabilitiesObj?.[device.ui?.quickAction];
  return capability?.type === 'boolean' && capability.setable ? capability : null;
}

// What a lock's tile shows, unless another indicator was chosen for it: 'locked', 'unlocked' or null.
export function lockState(device) {
  const locked = device.capabilitiesObj?.locked?.value;
  if (locked == null || (device.uiIndicator && device.uiIndicator !== 'locked')) return null;
  return locked ? 'locked' : 'unlocked';
}

// Mirrors the mobile tiles: an offline device says so; climate devices show their temperature, even when off;
// on/off devices show On (with dim level) or Off, even with a power reading as indicator; a lock whether it is locked;
// others their UI indicator, and without one a blind or window how far it is open.
export function deviceStatus(device) {
  if (device.available === false) return 'No Response';
  const capabilities = device.capabilitiesObj ?? {};
  const temperature = capabilities.measure_temperature ?? capabilities.target_temperature;
  if (temperature?.value != null && isClass(device, 'airconditioning', 'thermostat', 'heater')) return formatCapability(temperature);
  if (device.ui?.quickAction === 'onoff' && capabilities.onoff) {
    if (!capabilities.onoff.value) return 'Off';
    return capabilities.dim?.value != null ? `On • ${Math.round(capabilities.dim.value * 100)}%` : 'On';
  }
  const lock = lockState(device);
  if (lock) return lock === 'locked' ? 'Locked' : 'Unlocked';
  if (device.uiIndicator && capabilities[device.uiIndicator]) return formatCapability(capabilities[device.uiIndicator]);
  if (capabilities.windowcoverings_set?.value != null) return formatCapability(capabilities.windowcoverings_set);
  return '';
}

// Icons a user picks in the device settings are only stored by name. Homey's own web app serves the artwork
// at /web/img/devices/<name>.svg, so the app loads it from the Homey instead of shipping it.
// An unknown name returns the web app's HTML page (status 200), which the image probe below rejects.
const overrideIconBase = () => `${state.client.base}/web/img/devices/`;

const iconAvailability = new Map();

function iconLoads(url) {
  if (!iconAvailability.has(url)) {
    iconAvailability.set(url, new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(true);
      probe.onerror = () => resolve(false);
      probe.src = url;
    }));
  }
  return iconAvailability.get(url);
}

export function deviceIcon(device, className) {
  const icon = el('span', `mask-icon ${className}`);
  const driverIcon = device.iconObj?.url ? `${state.client.base}${device.iconObj.url}` : FALLBACK_DEVICE_ICON;
  const setIcon = (url) => icon.style.setProperty('--icon', `url("${url}")`);
  if (device.iconOverride) {
    const overrideIcon = `${overrideIconBase()}${encodeURIComponent(device.iconOverride)}.svg`;
    setIcon(overrideIcon);
    // Without internet access (or for an unknown name) fall back to the driver's icon.
    iconLoads(overrideIcon).then((loads) => {
      if (!loads) setIcon(driverIcon);
    });
  } else {
    setIcon(driverIcon);
  }
  return icon;
}

// Keeps the shared device object current; every widget showing the device re-renders from it.
export function watchDevice(device, update) {
  return subscribe(`homey:device:${device.id}`, 'capability', ({ capabilityId, value }) => {
    const capability = device.capabilitiesObj?.[capabilityId];
    if (capability == null) return;
    capability.value = value;
    update(capabilityId);
  });
}

export async function putCapability(device, capabilityId, value) {
  try {
    await state.client.api(
      'PUT',
      `/api/manager/devices/device/${device.id}/capability/${encodeURIComponent(capabilityId)}`,
      { value },
    );
    return true;
  } catch (error) {
    toast(`${device.name}: ${error.message}`);
    return false;
  }
}

// Shows the new value immediately and rolls back if Homey rejects it.
export async function setCapability(device, capabilityId, value, update) {
  const capability = device.capabilitiesObj?.[capabilityId];
  const previous = capability?.value;
  if (capability) capability.value = value;
  update();
  if (!(await putCapability(device, capabilityId, value)) && capability) {
    capability.value = previous;
    update();
  }
}

export function findDevice(body, id) {
  if (!requireData(body, 'devices')) return null;
  const device = state.data.devices[id];
  if (device == null) note(body, 'This device no longer exists.');
  return device ?? null;
}

export const isClass = (device, ...classes) => classes.includes(device.virtualClass ?? device.class);

export function groupMembers(group) {
  return Object.values(state.data.devices ?? {}).filter((member) => member.group === group.id);
}
