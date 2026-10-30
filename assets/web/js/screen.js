// Screens: each browser keeps a random id of its own, so the app can name it ("Hallway tablet") and flow cards can aim
// at it. The id survives reloads and Settings → Forget. The name is given when the browser is approved and changed in
// the app's settings in the Homey app. A browser without storage (private mode) has no id and only follows flow cards
// aimed at all screens. Only when served by the app.

import { APP_ID, servedByHomey } from './config.js';
import { subscribe } from './realtime.js';
import { STORAGE_KEY, state } from './state.js';

const SCREEN_KEY = `${STORAGE_KEY}:screen`;

let id; // Read once; null without storage.

// Broker sessions carry the identity approved by Homey. Adopt it before screen
// registration, without creating a second identity in browser storage.
export function adoptScreenId(screenId) {
  if (typeof screenId === 'string' && screenId) id = screenId;
}

// crypto.randomUUID() needs https, and the dashboard may be opened over plain http.
function newId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function screenId() {
  if (id !== undefined) return id;
  try {
    id = localStorage.getItem(SCREEN_KEY);
    if (id == null) {
      const created = newId();
      localStorage.setItem(SCREEN_KEY, created);
      // An id that wasn't stored would be a new screen on every load.
      id = localStorage.getItem(SCREEN_KEY) === created ? created : null;
    }
  } catch {
    id = null;
  }
  return id;
}

// A name you can recognise in the settings page, e.g. "Safari on iPad".
export function browserName() {
  const ua = navigator.userAgent;
  const browser = /Edg/.test(ua) ? 'Edge'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox'
      : /Chrome|CriOS/.test(ua) ? 'Chrome'
        : /Safari/.test(ua) ? 'Safari'
          : 'Browser';
  // iPads ask for the desktop site, so they look like a Mac with a touch screen.
  const device = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? 'Android'
        : /Macintosh/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux'
              : null;
  return device ? `${browser} on ${device}` : browser;
}

// Tells the app this screen is here (it adds one it doesn't know yet) and learns its name. On load and after
// reconnecting.
export async function registerScreen() {
  if (!servedByHomey || screenId() == null) return;
  const client = state.client;
  try {
    const { name } = await client.api('POST', `/api/app/${APP_ID}/screen-hello`, {
      token: client.token, id: screenId(), name: browserName(),
    });
    if (state.client === client) state.screenName = name;
  } catch (error) {
    console.info(`Screen: ${error.message}`);
  }
}

// Needs the client and the realtime connection. Keeps the name current when it is changed in the Homey app.
export function watchScreen() {
  if (!servedByHomey || screenId() == null) return;
  const client = state.client;
  subscribe(`homey:app:${APP_ID}`, 'screens', (screens) => {
    if (state.client !== client) return;
    // Forgotten while open, it has no name until the next load adds it back under its browser name.
    const self = Array.isArray(screens) ? screens.find((screen) => screen.id === screenId()) : null;
    state.screenName = self?.name ?? null;
  });
  registerScreen();
}
