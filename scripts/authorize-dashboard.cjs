'use strict';

// Preparation helper only: importing this file performs no requests. The caller
// supplies an already-authenticated Homey API client, pins its Homey ID and the
// installed app version, and obtains explicit approval before approved:true.
// It may use the existing Homey CLI session; this helper never creates a login,
// changes connection routes, retries token creation, or writes a secret to disk.

const APP_ID = 'dev.schweiger.dashboard';
const KEY_PATH = `/api/app/${APP_ID}/api-key`;
const DEDICATED_NAME = 'Metalcated Dashboard';
const DASHBOARD_SCOPES = Object.freeze([
  'homey.dashboard',
  'homey.device.readonly',
  'homey.device.control',
  'homey.flow.readonly',
  'homey.flow.start',
  'homey.mood.readonly',
  'homey.mood.set',
  'homey.logic.readonly',
  'homey.zone.readonly',
  'homey.notifications.readonly',
  'homey.app.readonly',
  'homey.user.readonly',
  'homey.user.self',
  'homey.insights.readonly',
  'homey.energy.readonly',
  'homey.system.readonly',
  'homey.geolocation.readonly',
  'homey.presence.self',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[^\s:\x00-\x1f\x7f]{1,4096}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fullKey = (value) => {
  if (typeof value !== 'string') return false;
  const separator = value.indexOf(':');
  return separator > 0 && UUID.test(value.slice(0, separator)) && SECRET.test(value.slice(separator + 1));
};

class AuthorizationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DashboardAuthorizationError';
    this.code = code;
  }
}

function stop(message, code) { throw new AuthorizationError(message, code); }

function extractKey(value) {
  if (fullKey(value)) return value;
  if (object(value)) {
    if (fullKey(value.key)) return value.key;
    if (fullKey(value.token)) return value.token;
    if (UUID.test(value.id ?? '') && typeof value.token === 'string' && SECRET.test(value.token)) {
      return `${value.id}:${value.token}`;
    }
  }
  stop('Homey returned an unrecognized key format. A dedicated key may exist; review API Keys before retrying. No key was saved by this helper.', 'UNKNOWN_KEY_FORMAT');
}

function configured(status) {
  if (!object(status) || typeof status.set !== 'boolean') stop('The app’s existing key status could not be verified. Nothing was replaced.', 'UNVERIFIED_KEY_STATUS');
  return status.set;
}

function checkNames(value) {
  const records = Array.isArray(value) ? value : object(value) ? Object.values(value) : null;
  if (!records || records.some((record) => !object(record) || typeof record.name !== 'string')) {
    stop('Existing API key names could not be verified. No dedicated key was created.', 'UNVERIFIED_KEY_NAMES');
  }
  const normalize = (name) => name.normalize('NFKC').trim().toLowerCase();
  if (records.some((record) => normalize(record.name) === normalize(DEDICATED_NAME))) {
    stop('A key named Metalcated Dashboard already exists. Review that key before retrying; this helper will not create a duplicate.', 'DEDICATED_KEY_EXISTS');
  }
}

async function authorize(homey, { homeyId, approved = false, expectedVersion } = {}) {
  if (approved !== true) stop('Explicit approval is required before creating and saving a dedicated dashboard key.', 'APPROVAL_REQUIRED');
  if (typeof homeyId !== 'string' || !homeyId || !homey || homey.id !== homeyId) {
    stop('The authenticated Homey does not match the approved Homey. No key was created.', 'WRONG_HOMEY');
  }
  if (typeof homey.call !== 'function' || typeof homey.users?.getPersonalAccessTokens !== 'function'
    || typeof homey.users?.createPersonalAccessToken !== 'function') {
    stop('This Homey client does not provide the verified key-management methods. No key was created.', 'UNSUPPORTED_CLIENT');
  }
  if (expectedVersion !== undefined && (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expectedVersion))) {
    stop('An explicit valid app version is required for the version check. No key was created.', 'INVALID_VERSION');
  }

  let stage = 'verify the installed dashboard app';
  let created = false;
  let key;
  try {
    if (expectedVersion !== undefined) {
      const app = await homey.call({ method: 'GET', path: `/api/manager/apps/app/${APP_ID}` });
      if (!object(app) || app.id !== APP_ID || app.version !== expectedVersion) {
        stop('The installed dashboard app does not match the approved version. No key was created.', 'WRONG_APP_VERSION');
      }
    }

    stage = 'verify the app’s existing key status';
    if (configured(await homey.call({ method: 'GET', path: KEY_PATH }))) {
      stop('The dashboard app already has a key configured. Nothing was replaced or created.', 'APP_KEY_EXISTS');
    }
    stage = 'verify existing API key names';
    checkNames(await homey.users.getPersonalAccessTokens());

    stage = 'create the dedicated dashboard key';
    // Exactly one creation attempt. Its outcome may be uncertain after a
    // transport failure; do not automatically retry or delete anything.
    created = true;
    const result = await homey.users.createPersonalAccessToken({ name: DEDICATED_NAME, scopes: [...DASHBOARD_SCOPES] });
    key = extractKey(result);
    if (object(result) && result.scopes !== undefined
      && (!Array.isArray(result.scopes) || result.scopes.length !== DASHBOARD_SCOPES.length
        || !DASHBOARD_SCOPES.every((scope) => result.scopes.includes(scope)))) {
      stop('Homey returned different permissions for the dedicated key. It was not saved; review API Keys before retrying.', 'UNEXPECTED_SCOPES');
    }

    stage = 'recheck the app before saving';
    if (configured(await homey.call({ method: 'GET', path: KEY_PATH }))) {
      stop('The dashboard app was configured while authorization was in progress. Nothing was overwritten; review the dedicated API key before retrying.', 'APP_KEY_CHANGED');
    }

    stage = 'validate and save the dedicated key in the dashboard app';
    const status = await homey.call({ method: 'PUT', path: KEY_PATH, body: { key, onlyIfUnset: true } });
    if (!object(status) || status.set !== true || status.canEdit !== true
      || !Array.isArray(status.missing) || status.missing.length !== 0
      || !Array.isArray(status.broad) || status.broad.length !== 0) {
      stop('The app did not confirm the expected dashboard permissions. No retry or automatic cleanup was performed; review API Keys and the app configuration.', 'VALIDATION_FAILED');
    }

    // Explicit whitelist: neither the API creation response nor app status can
    // disclose a credential, owner name, or unexpected field through this result.
    return { configured: true, scopes: [...DASHBOARD_SCOPES], canEdit: true, missing: [], broad: [] };
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    const next = created
      ? 'A dedicated key may exist. Review API Keys and the app configuration before retrying; no automatic retry or deletion was performed.'
      : 'No dedicated key was created.';
    // External errors may contain request bodies or credentials. Do not preserve
    // their message, response, cause, or stack on the safe error.
    throw new AuthorizationError(`Could not ${stage}. ${next}`, 'AUTHORIZATION_FAILED');
  } finally {
    key = undefined;
  }
}

module.exports = { authorize, DASHBOARD_SCOPES, DEDICATED_NAME };
