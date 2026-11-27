import { isIP } from 'node:net';
import { serviceOrigin } from './http.mjs';

const resourcePath = /^\/([a-z][a-z0-9-]*)\/[A-Za-z0-9_-]+(?:\/result|\/prompt)?(?:\?revision=([1-9][0-9]*)(?:&start=(0|[1-9][0-9]*)&end=([1-9][0-9]*))?)?$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const validRange = value => value && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
  && value.start >= 0 && value.start < value.end && value.end <= 100_000;

function field(value, path) {
  if (typeof path !== 'string') return undefined;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

// Only declared internal routes and exact returned coordinates become result links.
export function resultLink(value, fields, routes, token) {
  if (!value || !fields || typeof fields.hrefField !== 'string' || typeof fields.labelField !== 'string') return;
  let path = field(value, fields.hrefField);
  const match = typeof path === 'string' && path.length <= 2048 ? resourcePath.exec(path) : null;
  if (!match || match[0] !== path || !Array.isArray(routes) || !routes.includes(match[1]) || path.includes(token)) return;
  let revision = match[2] === undefined ? undefined : Number(match[2]);
  if (revision !== undefined && !positive(revision)) return;
  let range = match[3] === undefined ? undefined : { start: Number(match[3]), end: Number(match[4]) };
  if (range !== undefined && !validRange(range)) return;
  if (fields.revisionField !== undefined) {
    const exact = field(value, fields.revisionField);
    if (!positive(exact) || revision !== undefined && revision !== exact) return;
    revision = exact;
  }
  if (fields.rangeField !== undefined) {
    const selected = field(value, fields.rangeField);
    if (selected !== undefined) {
      if (!validRange(selected) || range && (range.start !== selected.start || range.end !== selected.end)) return;
      range = selected;
    }
  }
  if (range && revision === undefined) return;
  path = path.split('?')[0] + (revision === undefined ? '' : `?revision=${revision}`)
    + (range ? `&start=${range.start}&end=${range.end}` : '');
  let label = field(value, fields.labelField);
  label = typeof label === 'string'
    ? Array.from(label.replaceAll(token, '[redacted]').replace(/\s+/gu, ' ').trim()).slice(0, 300).join('') : '';
  return { path, label };
}

// This origin is for display only. API requests always use the paired service origin.
export function portalOrigin(value = process.env.STH_PERSONAL_OPERATIONS_PORTAL_ORIGIN) {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#\s\\%@\x00-\x1f\x7f]+\/?$/i.test(value)) return;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (['127.0.0.1', '::1', 'localhost'].includes(host.replace(/\.$/, '')) || url.port === '0') return;
    const ipv4 = isIP(host) === 4 && host.split('.').map(Number);
    const lan = ipv4 && (ipv4[0] === 10 || ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31 || ipv4[0] === 192 && ipv4[1] === 168)
      || isIP(host) === 6 && /^(fc|fd)/i.test(host) || host.replace(/\.$/, '').endsWith('.local') && host.replace(/\.$/, '') !== 'localhost.local';
    if (url.protocol === 'http:' && !lan) return;
    // Reuse the API origin parser for HTTPS normalization, with LAN HTTP kept display-only.
    return url.protocol === 'https:' ? serviceOrigin(value) : url.origin;
  } catch { return; }
}

export function linkText({ label, url }) {
  return `[${(label || 'Sth').replace(/[\\[\]`<>]/g, '\\$&')}](${url})`;
}
