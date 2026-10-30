// Pairing: a browser without an API key asks the Web Dashboard app for a code, you approve that code in the
// app's settings in the Homey app, and the app gives this browser a scoped connection. A kiosk tablet uses the same flow with
// purpose 'unlock' to open its settings; that approval hands out nothing. Only used when served by the app.

import { $ } from './dom.js';
import { browserName, screenId } from './screen.js';

// The page lives at /app/<app id>/assets/web/; the app's API at /api/app/<app id>.
const APP_API = `/api/app/${location.pathname.split('/')[2]}`;
const POLL_INTERVAL = 2000;

async function call(method, path, body) {
  const response = await fetch(APP_API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error_description ?? data?.error ?? `${response.status} ${response.statusText}`);
  return data;
}

// `retry` labels the button that starts over; without it the button is hidden.
function showStatus(text, { isError = false, retry = null } = {}) {
  $('pairing-status').textContent = text;
  $('pairing-status').classList.toggle('is-error', isError);
  $('pairing-retry').hidden = retry == null;
  $('pairing-retry').textContent = retry ?? '';
}

// Asks for a code and waits for it to be approved. Calling start() again starts over with a new code (for the same
// purpose when none is given); stop() ends it. onApproved(token, purpose, result); unlocking gets no token.
export function createPairing({ onApproved }) {
  let attempt = 0;
  let timer = null;
  let purpose = 'pair';

  function stop() {
    attempt += 1;
    clearTimeout(timer);
  }

  function poll(id, expiresAt, current) {
    timer = setTimeout(async () => {
      let result;
      try {
        result = await call('GET', `/pairing/${id}`);
      } catch {
        // Wi-Fi hiccup or Homey restarting: keep asking until the code runs out.
        result = { status: Date.now() < expiresAt ? 'waiting' : 'expired' };
      }
      if (current !== attempt) return;
      if (result.status === 'approved') {
        onApproved(result.token, purpose, result);
      } else if (result.status === 'waiting') {
        poll(id, expiresAt, current);
      } else if (result.status === 'declined') {
        $('pairing-code').textContent = '··· ···';
        showStatus('This browser was declined.', { isError: true, retry: 'New code' });
      } else {
        $('pairing-code').textContent = '··· ···';
        showStatus('The code expired.', { retry: 'New code' });
      }
    }, POLL_INTERVAL);
  }

  async function start(options) {
    stop();
    if (options?.purpose) purpose = options.purpose;
    const current = attempt;
    $('pairing-code').textContent = '··· ···';
    showStatus('Asking Homey for a code…');
    try {
      const { id, code, expiresAt } = await call('POST', '/pairing', { name: browserName(), purpose, screenId: screenId() });
      if (current !== attempt) return;
      $('pairing-code').textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
      showStatus('Waiting for approval…');
      poll(id, expiresAt, current);
    } catch (error) {
      if (current !== attempt) return;
      showStatus(error.message, { isError: true, retry: 'Try again' });
    }
  }

  return { start, stop };
}
