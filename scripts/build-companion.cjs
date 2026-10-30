#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const APP_ID = 'dev.schweiger.dashboard';
const COMPANION_DIR = path.resolve(__dirname, '../companion');
const DEFAULT_OUT = path.join(COMPANION_DIR, 'package');

function invalid(code, message) {
  return Object.assign(new Error(message), { code });
}

function isPrivateIPv4(host) {
  if (net.isIP(host) !== 4) return false;
  const [first, second] = host.split('.').map(Number);
  return first === 10 || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

function isLocalHostname(host, protocol) {
  const literal = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) === 4) return isPrivateIPv4(literal);
  if (net.isIP(literal) === 6) {
    return literal === '::1' || /^(?:fc|fd)[\da-f]{2}:/i.test(literal)
      || /^fe[89ab][\da-f]:/i.test(literal);
  }
  if (!host.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  const certified = /^(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})\.homey\.homeylocal\.com$/.exec(host);
  return protocol === 'https:' && Boolean(certified && isPrivateIPv4(certified[1].replaceAll('-', '.')));
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\s\\]/.test(value)
    || !/^https?:\/\/[^/?#]+\/?$/i.test(value)) {
    throw invalid('INVALID_ORIGIN', 'Use a plain HTTP or HTTPS origin for your local Homey.');
  }
  let url;
  try { url = new URL(value); } catch {
    throw invalid('INVALID_ORIGIN', 'Use a plain HTTP or HTTPS origin for your local Homey.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !isLocalHostname(url.hostname, url.protocol)) {
    throw invalid('INVALID_ORIGIN', 'Use a local Homey origin without a path, credentials, query, or fragment.');
  }
  // The exact port is retained here and checked by content.js before any UI is added.
  return url.origin;
}

function normalizeHomeyId(value) {
  if (typeof value !== 'string' || !/^[\da-f]{24}$/i.test(value)) {
    throw invalid('INVALID_HOMEY_ID', 'The Homey ID must contain exactly 24 hexadecimal characters.');
  }
  return value.toLowerCase();
}

function normalizeBrowser(value = 'chromium') {
  if (['chromium', 'chrome', 'edge'].includes(value)) return 'chromium';
  if (['firefox', 'zen'].includes(value)) return 'firefox';
  throw invalid('INVALID_BROWSER', 'Choose --browser chromium or --browser firefox.');
}

function matchPatterns(origin, homeyId) {
  const url = new URL(normalizeOrigin(origin));
  const id = normalizeHomeyId(homeyId);
  // Chrome patterns default to all ports when no port is specified. The runtime
  // exact-origin check is mandatory; neither scheme nor host uses a wildcard.
  const base = `${url.protocol}//${url.hostname}/web/homeys/${id}`;
  return [base, `${base}/*`];
}

function normalizeOutput(value = DEFAULT_OUT) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) {
    throw invalid('INVALID_OUTPUT', 'Choose a fresh output directory.');
  }
  const output = path.resolve(value);
  if (output === path.parse(output).root) throw invalid('INVALID_OUTPUT', 'Choose a fresh output directory.');
  return output;
}

function parseArguments(args) {
  const options = {};
  const names = new Map([['--origin', 'origin'], ['--homey-id', 'homeyId'], ['--out', 'out'], ['--browser', 'browser']]);
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]);
    const value = args[index + 1];
    if (!key || Object.hasOwn(options, key) || !value || value.startsWith('--')) {
      throw invalid('INVALID_ARGUMENTS', 'Use --origin URL --homey-id ID [--browser chromium|firefox] [--out FRESH_DIRECTORY].');
    }
    options[key] = value;
  }
  if (Object.hasOwn(options, 'browser')) options.browser = normalizeBrowser(options.browser);
  return options;
}

async function buildCompanion(options = {}) {
  const browser = normalizeBrowser(options.browser);
  const config = Object.freeze({
    origin: normalizeOrigin(options.origin),
    homeyId: normalizeHomeyId(options.homeyId),
    appId: APP_ID,
  });
  const output = normalizeOutput(options.out);
  try {
    await fs.lstat(output);
    throw invalid('OUTPUT_EXISTS', 'The output directory already exists. Choose a fresh directory; existing files are never replaced.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let source;
  try {
    source = await Promise.all([
      fs.readFile(path.join(COMPANION_DIR, 'manifest.template.json'), 'utf8'),
      fs.readFile(path.join(COMPANION_DIR, 'content.js')),
      fs.readFile(path.join(COMPANION_DIR, 'content.css')),
    ]);
  } catch {
    throw invalid('SOURCE_UNAVAILABLE', 'The companion source files could not be read. No package was created.');
  }
  const manifest = JSON.parse(source[0]);
  manifest.content_scripts[0].matches = matchPatterns(config.origin, config.homeyId);
  if (browser === 'firefox') {
    manifest.browser_specific_settings = {
      gecko: {
        id: 'homey-dashboard-companion@metalcated.dev',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
    };
  }
  const files = new Map([
    ['manifest.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['config.js', `'use strict';\nconst HOMEY_DASHBOARD_COMPANION = Object.freeze(${JSON.stringify(config, null, 2)});\n`],
    ['content.js', source[1]],
    ['content.css', source[2]],
  ]);
  try {
    // Exclusive creation protects an existing folder, even if another build won
    // the race after the initial check. Do not clean up or delete on failure.
    await fs.mkdir(output);
    for (const [name, contents] of files) {
      await fs.writeFile(path.join(output, name), contents, { flag: 'wx' });
    }
  } catch (error) {
    if (error.code === 'EEXIST') throw invalid('OUTPUT_EXISTS', 'The output directory already exists. Choose a fresh directory; existing files are never replaced.');
    throw invalid('OUTPUT_UNAVAILABLE', 'The package could not be written. Ensure its parent directory exists and choose a fresh output directory.');
  }
  return { output, config, manifest };
}

if (require.main === module) {
  Promise.resolve().then(() => buildCompanion(parseArguments(process.argv.slice(2))))
    .then(({ output }) => { process.stdout.write(`${output}\n`); })
    .catch((error) => {
      process.stderr.write(`${error.code ? error.message : 'The companion package could not be built.'}\n`);
      process.exitCode = 1;
    });
}

module.exports = { APP_ID, DEFAULT_OUT, buildCompanion, matchPatterns, normalizeBrowser, normalizeHomeyId, normalizeOrigin, normalizeOutput, parseArguments };
