export const DEFAULT_ORIGIN = 'http://127.0.0.1:9321';
const root = '/api/v1/personal-operations';

export function serviceOrigin(value = process.env.STH_PERSONAL_OPERATIONS_ORIGIN || DEFAULT_ORIGIN) {
  const message = 'Set a plain HTTPS origin or a loopback HTTP origin.';
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#\s\\%@\x00-\x1f\x7f]+\/?$/i.test(value)) {
    throw new Error(message);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (url.port === '0' || (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error(message);
  }
  return url.origin;
}

export async function request(origin, endpoint, body, token) {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${origin}${root}/${endpoint}`, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) {
    await response.body?.cancel();
    return { status: 401, value: {} };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > 5 * 1024 * 1024) throw new Error('Sth response exceeded the size limit.');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Sth response.');
  return { status: response.status, value };
}
