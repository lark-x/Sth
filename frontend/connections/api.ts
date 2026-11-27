import { ApiError } from '../api.ts';

export interface Connection {
  connectionId: string;
  clientName: string;
  createdAt: string;
  revokedAt: string | null;
}

const uuid = /^[a-f0-9-]{36}$/i;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

async function request(path: string, signal: AbortSignal, write = false): Promise<unknown> {
  const timeout = AbortSignal.timeout(15_000);
  let response: Response;
  let data: unknown;
  try {
    response = await fetch(`/api/web/connections${path}`, {
      method: write ? 'POST' : 'GET',
      headers: write ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: write ? '{}' : undefined,
      credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([signal, timeout]),
    });
    data = await response.json().catch(() => null);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError(0, 'network', timeout.aborted ? '请求超时，请重试。' : '无法连接本地服务，请检查连接后重试。');
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? '当前无法访问，请检查 Sth 的访问地址和登录状态。'
      : response.status === 429 ? '请求过于频繁，请稍后重试。' : '操作失败，请重试。';
    throw new ApiError(response.status, '', message);
  }
  return data;
}

function invalid(): never { throw new ApiError(502, 'invalid_result', '服务返回的数据无法读取，请重试。'); }

export async function listConnections(signal: AbortSignal): Promise<Connection[]> {
  const data = await request('', signal) as { items?: Connection[] } | null;
  if (!Array.isArray(data?.items) || !data.items.every(item => item && uuid.test(item.connectionId)
    && typeof item.clientName === 'string' && timestamp(item.createdAt)
    && (item.revokedAt === null || timestamp(item.revokedAt)))) return invalid();
  return data.items;
}

export async function issueCode(signal: AbortSignal): Promise<{ code: string; expiresAt: string }> {
  const data = await request('/code', signal, true) as { code?: unknown; expiresAt?: unknown } | null;
  if (typeof data?.code !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(data.code) || !timestamp(data.expiresAt)) return invalid();
  return { code: data.code, expiresAt: data.expiresAt };
}

export async function revokeConnection(id: string, signal: AbortSignal): Promise<void> {
  if (!uuid.test(id)) return invalid();
  const data = await request(`/${encodeURIComponent(id)}/revoke`, signal, true) as { connectionId?: unknown; revoked?: unknown } | null;
  if (data?.connectionId !== id || data.revoked !== true) invalid();
}
