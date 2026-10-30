'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { APP_ID, buildCompanion, matchPatterns, normalizeHomeyId, normalizeOrigin, normalizeOutput, parseArguments } = require('../scripts/build-companion.cjs');

const ID = '6add33dde406853bfda0bd09';
const ORIGIN = 'http://192.168.80.87:4859';

test('accepts only explicitly local HTTP(S) origins and retains the exact protocol and port', () => {
  for (const origin of [
    ORIGIN, 'https://192.168.80.87:4860', 'http://10.0.0.1', 'http://172.16.0.2',
    'http://172.31.255.254', 'http://127.0.0.1:8765', 'http://localhost:4859',
    'https://homey.local', 'http://homey.lan', 'https://homey.home.arpa', 'http://test.localhost',
    'http://[::1]:4859', 'https://[fd12::1]:4860', 'http://[fe80::1]:4859',
    'https://192-168-80-87.homey.homeylocal.com',
  ]) assert.equal(normalizeOrigin(`${origin}/`), origin);
});

test('rejects public destinations, URL credentials, paths, injected code, and cloud fallbacks', () => {
  for (const origin of [
    undefined, '', 'file:///tmp/homey', 'javascript:alert(1)', '//192.168.80.87',
    'http://8.8.8.8', 'http://172.15.255.255', 'http://172.32.0.1', 'http://192.169.0.1',
    'http://0.0.0.0', 'http://[2001:4860:4860::8888]', 'https://my.homey.app', 'https://example.com',
    'http://192.168.80.87/web/homeys/', 'http://192.168.80.87/%2e%2e/',
    'http://192.168.80.87/?', 'http://192.168.80.87/#', 'http://192.168.80.87/?token=secret',
    'http://user:secret@192.168.80.87', 'http://192.168.80.87@evil.example',
    'http://homey.local.evil.example', 'http://192-168-80-87.homey.homeylocal.com',
    'https://8-8-8-8.homey.homeylocal.com', 'https://192-168-80-87.homey.homeylocal.com.evil',
    'http://192.168.80.87\\@evil.example', 'http://homey.local\n',
    'http://a";globalThis.injected=true;//.local', 'http://*.local',
  ]) assert.throws(() => normalizeOrigin(origin), { code: 'INVALID_ORIGIN' });
});

test('requires the exact Homey ID format and only matches its own web routes', () => {
  assert.equal(APP_ID, 'dev.schweiger.dashboard');
  assert.equal(normalizeHomeyId(ID.toUpperCase()), ID);
  for (const id of [undefined, '', `${ID}/settings`, `${ID}*`, '../settings', `${ID}1`, 'g'.repeat(24)]) {
    assert.throws(() => normalizeHomeyId(id), { code: 'INVALID_HOMEY_ID' });
  }
  assert.deepEqual(matchPatterns(ORIGIN, ID), [
    `http://192.168.80.87/web/homeys/${ID}`,
    `http://192.168.80.87/web/homeys/${ID}/*`,
  ]);
  assert.deepEqual(matchPatterns('https://localhost:4859', ID), [
    `https://localhost/web/homeys/${ID}`,
    `https://localhost/web/homeys/${ID}/*`,
  ]);
});

test('argument validation refuses ambiguous options and paths with control characters', () => {
  assert.deepEqual(parseArguments(['--origin', ORIGIN, '--homey-id', ID, '--out', '/private/tmp/fresh-package']), {
    origin: ORIGIN, homeyId: ID, out: '/private/tmp/fresh-package',
  });
  for (const args of [
    ['--origin'], ['--origin', ORIGIN, '--origin', ORIGIN], ['--replace', 'true'],
    ['--token', 'secret'], ['--homey-id', '--out'], ['--out=/private/tmp/package'],
  ]) assert.throws(() => parseArguments(args), { code: 'INVALID_ARGUMENTS' });
  for (const output of ['', '/', '/private/tmp/package\nother', '\0']) {
    assert.throws(() => normalizeOutput(output), { code: 'INVALID_OUTPUT' });
  }
});

test('CLI errors never echo URL credentials, arguments, or a stack trace', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../scripts/build-companion.cjs'), '--origin',
    'http://private-owner:do-not-print-this-secret@192.168.80.87:4859', '--homey-id', ID,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /local Homey origin/);
  assert.doesNotMatch(result.stderr, /private-owner|do-not-print|192\.168|\n\s+at /);
});

test('builds a complete isolated package with no extra permissions, URLs, or credentials and never overwrites it', async () => {
  // All test artifacts are newly created below the OS temporary directory. They
  // are intentionally retained: the builder never deletes existing files.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homey-companion-test-'));
  const output = path.join(directory, 'package');
  const result = await buildCompanion({ origin: ORIGIN, homeyId: ID, out: output });
  assert.equal(result.output, output);
  assert.deepEqual((await fs.readdir(output)).sort(), ['config.js', 'content.css', 'content.js', 'manifest.json']);

  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['content_scripts', 'description', 'manifest_version', 'name', 'version']);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0], {
    matches: [`http://192.168.80.87/web/homeys/${ID}`, `http://192.168.80.87/web/homeys/${ID}/*`],
    js: ['config.js', 'content.js'], css: ['content.css'], run_at: 'document_idle', all_frames: false,
    match_about_blank: false, match_origin_as_fallback: false, world: 'ISOLATED',
  });
  const configSource = await fs.readFile(path.join(output, 'config.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(configSource, context);
  assert.equal(vm.runInContext('Object.isFrozen(HOMEY_DASHBOARD_COMPANION)', context), true);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(HOMEY_DASHBOARD_COMPANION)', context)), {
    origin: ORIGIN, homeyId: ID, appId: APP_ID,
  });
  for (const file of ['content.js', 'content.css']) {
    assert.deepEqual(await fs.readFile(path.join(output, file)), await fs.readFile(path.join(__dirname, '../companion', file)));
  }

  const original = await fs.readFile(path.join(output, 'manifest.json'));
  await assert.rejects(buildCompanion({ origin: 'https://localhost:4859', homeyId: ID, out: output }), { code: 'OUTPUT_EXISTS' });
  assert.deepEqual(await fs.readFile(path.join(output, 'manifest.json')), original);
  const fileOutput = path.join(directory, 'existing-file');
  await fs.writeFile(fileOutput, 'keep existing data', { flag: 'wx' });
  await assert.rejects(buildCompanion({ origin: ORIGIN, homeyId: ID, out: fileOutput }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await fs.readFile(fileOutput, 'utf8'), 'keep existing data');
});

test('invalid origin or ID never creates an output directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homey-companion-invalid-'));
  const output = path.join(directory, 'package');
  await assert.rejects(buildCompanion({ origin: 'https://example.com', homeyId: ID, out: output }), { code: 'INVALID_ORIGIN' });
  await assert.rejects(buildCompanion({ origin: ORIGIN, homeyId: `${ID}*`, out: output }), { code: 'INVALID_HOMEY_ID' });
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});
