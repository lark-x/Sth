import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { Operations, OperationError } from './core/index.ts';
import { libraryOperations } from './library/index.ts';
import { authenticate, claim, issueCode, listConnections, revoke } from './connections.ts';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const personal = '/api/v1/personal-operations/';
const contentTypes: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2', '.html': 'text/html' };

function fail(status: number, code: string, message: string): never {
  throw new OperationError(status, code, message);
}

async function body(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    fail(415, 'json_required', '请求需要 JSON 格式。');
  }
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 1024 * 1024) fail(413, 'request_too_large', '内容超过大小限制。');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Converted to the common request error below. */ }
  return fail(400, 'invalid_json', '请求必须是 JSON 对象。');
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function page(path: string, res: ServerResponse, head: boolean) {
  const extension = extname(path);
  const isFile = Boolean(extension);
  if (isFile && !Object.hasOwn(contentTypes, extension)) fail(404, 'missing_asset', '资源不存在。');
  const file = resolve(webRoot, isFile ? '.' + path : 'index.html');
  if (!file.startsWith(resolve(webRoot) + sep)) fail(404, 'missing_asset', '资源不存在。');
  const data = await readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail(404, 'missing_asset', '资源不存在。');
    throw error;
  });
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Content-Type', (contentTypes[extension] || 'text/html') + '; charset=utf-8');
  res.end(head ? undefined : data);
}

export interface ServerSettings {
  publicOrigin?: string;
  webPassword?: string;
}

export function createApp(db: DatabaseSync, settings: ServerSettings = {}) {
  const operations = new Operations(db, libraryOperations);
  const publicUrl = settings.publicOrigin ? new URL(settings.publicOrigin) : undefined;
  if (publicUrl && (publicUrl.protocol !== 'https:' || publicUrl.origin !== settings.publicOrigin || !settings.webPassword)) {
    throw new Error('STH_PUBLIC_ORIGIN requires an HTTPS origin and STH_WEB_PASSWORD.');
  }
  const ownerDigest = createHash('sha256').update('sth:' + (settings.webPassword ?? '')).digest();
  return createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const host = req.headers.host;
      const port = req.socket.localPort;
      const local = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host || '');
      const remote = !local && publicUrl && host === publicUrl.host;
      if (!local && !remote) fail(403, 'untrusted_host', '无法识别此服务地址。');
      const origin = local ? `http://${host}` : publicUrl!.origin;
      if (req.headers.origin && req.headers.origin !== origin) fail(403, 'cross_origin', '请求来源不匹配。');
      const rawPath = req.url || '/';
      if (!rawPath.startsWith('/') || rawPath.startsWith('//')) fail(400, 'invalid_path', '路径无效。');
      const path = new URL(rawPath, origin).pathname;
      if (req.method === 'GET' && path === '/api/health') return json(res, { name: 'Sth', status: 'ok', schemaVersion: 1 });
      if (path.startsWith(personal)) {
        if (req.method !== 'POST') fail(405, 'method', '此操作需要 POST 请求。');
        const action = path.slice(personal.length);
        if (action === 'claim') return json(res, claim(db, await body(req)));
        const input = await body(req);
        const namespace = authenticate(db, req.headers.authorization);
        if (action === 'catalog') return json(res, operations.catalog());
        if (action === 'invoke') return json(res, operations.invoke(namespace, input));
        if (action === 'receipt') return json(res, operations.receipt(namespace, input));
        fail(404, 'missing_endpoint', '接口不存在。');
      }
      // Protect every owner route once remote access is configured, even if a proxy rewrites Host.
      if (publicUrl) {
        const credential = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization ?? '')?.[1];
        const actual = createHash('sha256').update(Buffer.from(credential ?? '', 'base64')).digest();
        if (!credential || !timingSafeEqual(actual, ownerDigest)) {
          res.setHeader('WWW-Authenticate', 'Basic realm="Sth", charset="UTF-8"');
          fail(401, 'owner_required', '请登录个人工作区。');
        }
      }
      if (path.startsWith('/api/')) {
        if (req.method === 'GET' && path === '/api/web/catalog') return json(res, operations.catalog());
        if (req.method === 'GET' && path === '/api/web/connections') return json(res, listConnections(db));
        if (req.method === 'POST') {
          const input = await body(req);
          if (path === '/api/web/invoke') return json(res, operations.invoke('web:owner', input));
          if (path === '/api/web/receipt') return json(res, operations.receipt('web:owner', input));
          if (path === '/api/web/connections/code') return json(res, issueCode(db));
          const match = /^\/api\/web\/connections\/([a-f0-9-]{36})\/revoke$/.exec(path);
          if (match) return json(res, revoke(db, match[1]));
        }
        fail(404, 'missing_endpoint', '接口不存在。');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'method', '不支持此请求方法。');
      await page(path, res, req.method === 'HEAD');
    } catch (error) {
      if (error instanceof OperationError) json(res, { error: error.code, code: error.code, message: error.message }, error.statusCode);
      else {
        console.error(error instanceof Error ? error.name : 'Request failed');
        json(res, { error: 'internal_error', message: '服务暂时无法处理请求。' }, 500);
      }
    }
  });
}
