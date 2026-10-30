// Minimal client for the Homey Web API.

export function createClient({ homeyUrl, token, transport, appId }) {
  const base = homeyUrl.trim().replace(/\/+$/, '');
  const address = new URL(base);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    throw new Error('Use your Homey’s HTTP or HTTPS address.');
  }
  const brokered = transport === 'broker';
  const id = appId ?? (/^\/app\/([^/]+)\/assets\//.exec(location.pathname)?.[1]);
  if (brokered && !id) throw new Error('Open this dashboard from the Homey app’s address.');

  async function readResponse(response) {
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const error = new Error(data?.error_description ?? data?.message ?? data?.error?.message
        ?? (typeof data?.error === 'string' ? data.error : `${response.status} ${response.statusText}`));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function broker(route, payload, { signal } = {}) {
    return readResponse(await fetch(`${base}/api/app/${encodeURIComponent(id)}/workspace/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, token }),
      cache: 'no-store',
      signal,
    }));
  }

  async function api(method, path, body) {
    if (brokered) return broker('request', { method, path, ...(body == null || method === 'GET' ? {} : { body }) });
    const hasBody = body != null && method !== 'GET';
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    return readResponse(response);
  }

  return { base, origin: address.origin, token, transport: brokered ? 'broker' : 'direct', api, broker };
}
