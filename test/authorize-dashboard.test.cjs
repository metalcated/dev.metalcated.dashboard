'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { authorize, DASHBOARD_SCOPES, DEDICATED_NAME } = require('../scripts/authorize-dashboard.cjs');

const ID = 'approved-homey';
const TOKEN_ID = '019c0000-1111-4222-8333-444444444444';
const SECRET = 'mock-secret-never-print-or-return';
const KEY = `${TOKEN_ID}:${SECRET}`;
const PATH = '/api/app/dev.schweiger.dashboard/api-key';
const approved = { homeyId: ID, approved: true, expectedVersion: '1.4.6' };

function fixture({ existing = false, names = [], result = { id: TOKEN_ID, token: SECRET }, status = {}, version = '1.4.6', failure, changed = false } = {}) {
  const calls = [];
  let reads = 0;
  const homey = {
    id: ID,
    users: {
      async getPersonalAccessTokens() { calls.push({ operation: 'list' }); return names; },
      async createPersonalAccessToken(options) {
        calls.push({ operation: 'create', options });
        if (failure) throw failure;
        return result;
      },
    },
    async call(request) {
      calls.push(request);
      if (request.path.startsWith('/api/manager/apps/app/')) return { id: 'dev.schweiger.dashboard', version };
      assert.equal(request.path, PATH);
      if (request.method === 'GET') { reads += 1; return { set: existing || (changed && reads === 2) }; }
      assert.equal(request.method, 'PUT');
      return { set: true, canEdit: true, missing: [], broad: [], user: 'Private owner', key: KEY, ...status };
    },
  };
  return { homey, calls, creates: () => calls.filter(({ operation }) => operation === 'create'), writes: () => calls.filter(({ method }) => method === 'PUT') };
}

test('requires explicit approval before any Homey request or mutation', async () => {
  for (const value of [undefined, false, 'true', 1]) {
    const mock = fixture();
    await assert.rejects(authorize(mock.homey, { homeyId: ID, approved: value }), { code: 'APPROVAL_REQUIRED' });
    assert.deepEqual(mock.calls, []);
  }
});

test('pins the approved Homey and app version before key creation', async () => {
  const wrongHomey = fixture();
  await assert.rejects(authorize(wrongHomey.homey, { ...approved, homeyId: 'another-homey' }), { code: 'WRONG_HOMEY' });
  assert.deepEqual(wrongHomey.calls, []);
  const wrongVersion = fixture({ version: '1.4.5' });
  await assert.rejects(authorize(wrongVersion.homey, approved), { code: 'WRONG_APP_VERSION' });
  assert.equal(wrongVersion.calls.length, 1);
  assert.equal(wrongVersion.creates().length, 0);
});

test('does not replace an existing app key or duplicate a dedicated key name', async () => {
  const configured = fixture({ existing: true });
  await assert.rejects(authorize(configured.homey, approved), { code: 'APP_KEY_EXISTS' });
  assert.equal(configured.creates().length, 0);
  assert.equal(configured.writes().length, 0);
  for (const names of [[{ name: DEDICATED_NAME }], { token: { name: '  METALCATED DASHBOARD  ' } }]) {
    const duplicate = fixture({ names });
    await assert.rejects(authorize(duplicate.homey, approved), { code: 'DEDICATED_KEY_EXISTS' });
    assert.equal(duplicate.creates().length, 0);
  }
});

test('creates exactly the dedicated scope set and returns only a safe whitelist', async () => {
  const mock = fixture();
  const result = await authorize(mock.homey, approved);
  assert.equal(mock.creates().length, 1);
  assert.deepEqual(mock.creates()[0].options, {
    name: 'Metalcated Dashboard',
    scopes: [
      'homey.dashboard', 'homey.device.readonly', 'homey.device.control', 'homey.flow.readonly', 'homey.flow.start',
      'homey.mood.readonly', 'homey.mood.set', 'homey.logic.readonly', 'homey.zone.readonly', 'homey.notifications.readonly',
      'homey.app.readonly', 'homey.user.readonly', 'homey.user.self', 'homey.insights.readonly', 'homey.energy.readonly',
      'homey.system.readonly', 'homey.geolocation.readonly', 'homey.presence.self',
    ],
  });
  assert.deepEqual(mock.writes(), [{ method: 'PUT', path: PATH, body: { key: KEY, onlyIfUnset: true } }]);
  assert.deepEqual(result, { configured: true, scopes: [...DASHBOARD_SCOPES], canEdit: true, missing: [], broad: [] });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes('Private owner'), false);
  assert.equal(result.scopes.some((scope) => ['homey', 'homey.app', 'homey.app.control', 'homey.flow'].includes(scope)), false);
});

test('recognizes full keys and combines an explicitly identified secret without mistaking a bare token for a key', async () => {
  for (const result of [KEY, { key: KEY }, { token: KEY }, { id: TOKEN_ID, token: SECRET }]) {
    const mock = fixture({ result });
    await authorize(mock.homey, approved);
    assert.equal(mock.writes()[0].body.key, KEY);
    assert.equal(mock.creates().length, 1);
  }
  for (const result of [SECRET, { token: SECRET }, { id: 'not-a-uuid', token: SECRET }, { accessToken: KEY }, { key: `${TOKEN_ID}:invalid secret` }]) {
    const mock = fixture({ result });
    await assert.rejects(authorize(mock.homey, approved), { code: 'UNKNOWN_KEY_FORMAT' });
    assert.equal(mock.creates().length, 1);
    assert.equal(mock.writes().length, 0);
  }
});

test('rechecks the destination and refuses to overwrite a key configured during authorization', async () => {
  const mock = fixture({ changed: true });
  await assert.rejects(authorize(mock.homey, approved), { code: 'APP_KEY_CHANGED' });
  assert.equal(mock.creates().length, 1);
  assert.equal(mock.writes().length, 0);
});

test('unknown metadata and unexpected returned permissions fail closed', async () => {
  const names = fixture({ names: { unknownEnvelope: [] } });
  await assert.rejects(authorize(names.homey, approved), { code: 'UNVERIFIED_KEY_NAMES' });
  assert.equal(names.creates().length, 0);
  const scopes = fixture({ result: { key: KEY, scopes: ['homey'] } });
  await assert.rejects(authorize(scopes.homey, approved), { code: 'UNEXPECTED_SCOPES' });
  assert.equal(scopes.writes().length, 0);
});

test('failed permission validation never reports configured success or retries creation', async () => {
  for (const status of [{ set: false }, { canEdit: false }, { missing: ['View devices'] }, { broad: ['Everything'] }]) {
    const mock = fixture({ status });
    await assert.rejects(authorize(mock.homey, approved), { code: 'VALIDATION_FAILED' });
    assert.equal(mock.creates().length, 1);
    assert.equal(mock.writes().length, 1);
  }
});

test('uncertain creation errors are not retried and cannot expose a credential or raw response', async () => {
  const external = Object.assign(new Error(`request body included ${KEY}`), { response: { token: KEY } });
  const mock = fixture({ failure: external });
  await assert.rejects(authorize(mock.homey, approved), (error) => {
    assert.equal(error.code, 'AUTHORIZATION_FAILED');
    assert.match(error.message, /A dedicated key may exist/);
    assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(SECRET), false);
    assert.equal(error.cause, undefined);
    assert.equal(error.response, undefined);
    return true;
  });
  assert.equal(mock.creates().length, 1);
  assert.equal(mock.writes().length, 0);
});
