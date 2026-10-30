// Reloads the page after the app is updated, so a wall tablet doesn't keep running the old dashboard. The page compares
// the app's version with the one it loaded with when Homey reports the app running again or the connection to Homey
// comes back. A developer install (`homey app install`) usually keeps the version, so it always reloads; a restart
// never does. The reload waits until nobody has touched the screen for a minute. Only when served by the app.

import { APP_ID, servedByHomey } from './config.js';
import { toast } from './dom.js';
import { subscribe } from './realtime.js';
import { STORAGE_KEY, state } from './state.js';

const IDLE = 60_000;
const RELOADED_KEY = `${STORAGE_KEY}:reloaded`;

let loadedVersion = null;
let reloading = false;
let installed = false;
let lastInput = Date.now();

function reloadWhenIdle() {
  const idleFor = Date.now() - lastInput;
  if (document.visibilityState === 'visible' && idleFor < IDLE) {
    setTimeout(reloadWhenIdle, IDLE - idleFor);
    return;
  }
  try {
    sessionStorage.setItem(RELOADED_KEY, loadedVersion);
  } catch {
    // Without storage the reload just isn't announced.
  }
  location.reload();
}

function reload(reason, why) {
  console.info(`Update check (${reason}): ${why}, reloading once idle`);
  reloading = true;
  reloadWhenIdle();
}

function compare(version, reason) {
  if (version == null || reloading) return;
  if (loadedVersion == null) loadedVersion = version;
  else if (version !== loadedVersion) reload(reason, `version ${loadedVersion} → ${version}`);
  else console.info(`Update check (${reason}): still version ${version}, not reloading`);
}

export async function checkForUpdate(reason) {
  if (!servedByHomey || reloading) return;
  const client = state.client;
  try {
    const app = await client.api('GET', `/api/manager/apps/app/${APP_ID}`);
    if (state.client === client) compare(app?.version, reason);
  } catch (error) {
    console.info(`Update check (${reason}) failed: ${error.message}`);
  }
}

// Needs the client and the realtime connection.
export function watchUpdates() {
  if (!servedByHomey) return;
  const client = state.client;
  try {
    const previous = sessionStorage.getItem(RELOADED_KEY);
    if (previous != null) {
      sessionStorage.removeItem(RELOADED_KEY);
      console.info(`Reloaded after an update from version ${previous}`);
      toast('Dashboard updated');
    }
  } catch {
    // Storage unavailable (private mode).
  }
  for (const type of ['pointerdown', 'keydown']) {
    addEventListener(type, () => { lastInput = Date.now(); }, { capture: true, passive: true });
  }
  checkForUpdate('page loaded');
  // Homey reports an install, update or restart as app.update events ending with state 'running'. An install also
  // deletes and creates the app, which tells it apart from a restart.
  subscribe('homey:manager:apps', 'app.create', (app) => {
    if (state.client !== client) return;
    if (app?.id === APP_ID) installed = true;
  });
  subscribe('homey:manager:apps', 'app.update', (app) => {
    if (state.client !== client) return;
    if (app?.id !== APP_ID || app.state !== 'running' || reloading) return;
    if (installed && app.origin?.startsWith('devkit')) reload('app started', `developer install (${app.origin})`);
    else compare(app.version, 'app started');
    installed = false;
  });
}
