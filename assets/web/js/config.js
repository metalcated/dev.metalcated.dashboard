// Connection settings: config.json next to the page, overridden by what the setup form stored.

import { STORAGE_KEY } from './state.js';
import { readConnection, writeConnection } from './connection-storage.js';
import { embedded, waitForEmbeddedConfig } from './embedded.js';

// Served by the Homey app (/app/<app id>/assets/web/), Homey is this page's own origin.
export const servedByHomey = /^\/app\/[^/]+\/assets\//.test(location.pathname);
export const APP_ID = servedByHomey ? location.pathname.split('/')[2] : null;

function readLegacyConfig() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export const writeStoredConfig = (config) => embedded ? Promise.resolve(false) : writeConnection(config);

export async function loadConfig() {
  if (embedded) return waitForEmbeddedConfig();
  // A config.json inside the installed app would be readable by anyone on the network, so only standalone mode reads it.
  let fileConfig = {};
  if (!servedByHomey) {
    try {
      const response = await fetch('config.json', { cache: 'no-store' });
      if (response.ok) fileConfig = await response.json();
    } catch {
      // No config.json next to the page; fall back to the setup form.
    }
  }
  let stored = await readConnection();
  if (stored == null) {
    stored = readLegacyConfig();
    // Migrate once without removing the legacy record. An empty database record
    // is intentional after Disconnect and prevents an old key coming back.
    await writeConnection(stored);
  }
  const config = { ...fileConfig, ...stored };
  if (servedByHomey) config.homeyUrl = location.origin;
  return config;
}
