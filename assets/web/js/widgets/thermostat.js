// Thermostat card, also used in the climate sheet.

import { deviceIcon, findDevice, setCapability, watchDevice } from '../devices.js';
import { el, note } from '../dom.js';
import { ARROW_UP, CHEVRON_DOWN, CHEVRON_UP } from '../icons.js';

// A thermostat card: the orange widget, or the dark list card used in the climate sheet.
export function thermostatControl(device, { title = device.name, variant = 'widget' } = {}) {
  const capabilities = device.capabilitiesObj ?? {};
  const target = capabilities.target_temperature;
  const card = el('div', variant === 'list' ? 'thermostat is-list' : 'thermostat');
  const main = el('div', 'thermostat-main');
  const glyph = el('div', 'thermostat-glyph');
  const badge = el('span', 'thermostat-badge');
  badge.innerHTML = ARROW_UP;
  glyph.append(deviceIcon(device, ''), badge);
  const text = el('div', 'panel-text');
  const temps = el('div', 'thermostat-temps');
  text.append(el('div', 'thermostat-name', title), temps);
  main.append(glyph, text);
  const steps = el('div', 'thermostat-steps');
  const up = el('button');
  up.type = 'button';
  up.innerHTML = CHEVRON_UP;
  up.setAttribute('aria-label', `Raise the target temperature of ${device.name}`);
  const down = el('button');
  down.type = 'button';
  down.innerHTML = CHEVRON_DOWN;
  down.setAttribute('aria-label', `Lower the target temperature of ${device.name}`);
  steps.append(up, down);
  card.append(main, steps);

  const step = target.step ?? 0.5;
  const decimals = Math.min(target.decimals ?? 1, 2);
  const format = (celsius) => (celsius == null ? '–' : `${Number(celsius).toFixed(decimals)}°`);
  let pending = null;
  let sendTimer = null;

  function update() {
    const targetValue = pending ?? target.value;
    const current = capabilities.measure_temperature?.value;
    const mode = capabilities.thermostat_mode?.value;
    // A device that is switched off (like an air conditioner) only shows its target, greyed out.
    const off = capabilities.onoff?.value === false;
    const heating = !off && (mode === 'heat'
      || (mode !== 'cool' && mode !== 'off' && current != null && targetValue != null && targetValue > current));
    const cooling = !off && mode === 'cool';
    card.classList.toggle('is-heating', heating);
    card.classList.toggle('is-cooling', cooling);
    card.classList.toggle('is-off', off);
    // Not heating or cooling towards its target (it is reached): a plain card with the target alone, as in the app.
    const idle = !off && !heating && !cooling;
    card.classList.toggle('is-idle', idle);
    temps.replaceChildren();
    if (off || idle) {
      temps.append(el('span', 'current', format(targetValue)));
    } else {
      if (current != null) temps.append(el('span', 'current', format(current)), el('span', 'arrow', '→'));
      temps.append(el('span', 'target', format(targetValue)));
    }
    const unavailable = device.available === false;
    up.disabled = unavailable || (target.max != null && targetValue >= target.max);
    down.disabled = unavailable || (target.min != null && targetValue <= target.min);
  }

  // Quick taps are collected into one request.
  const nudge = (direction) => {
    const next = Number((Math.round(((pending ?? target.value ?? 20) + direction * step) / step) * step).toFixed(2));
    pending = Math.min(target.max ?? Infinity, Math.max(target.min ?? -Infinity, next));
    update();
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      const value = pending;
      pending = null;
      setCapability(device, 'target_temperature', value, update);
    }, 700);
  };
  up.addEventListener('click', () => nudge(1));
  down.addEventListener('click', () => nudge(-1));

  update();
  const stop = watchDevice(device, update);
  return {
    node: card,
    cleanup: () => {
      stop();
      clearTimeout(sendTimer);
    },
  };
}

export function mountThermostat({ body, widget }) {
  const device = findDevice(body, widget.data?.deviceId);
  if (device == null) return;
  if (device.capabilitiesObj?.target_temperature == null) return note(body, `${device.name} has no target temperature.`);
  const control = thermostatControl(device, { title: widget.title ?? device.name });
  body.append(control.node);
  return control.cleanup;
}
