import type { Draft, Scene, SceneSummary } from '../../src/story/contracts.ts';
import { ApiError, operation } from '../api.ts';
import type { OperationCall } from '../api.ts';
export type { Draft, Scene, SceneSummary, OperationCall };
export { ApiError };
export type DraftSummary = Omit<Draft, 'body'>;
export interface Narrative { narrativeId: string; title: string; revision: number; sceneRevision: number }
export interface Backlink { characterId: string; name: string; revision: number; label: string; reference: { excerpt?: string } }

async function request(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await fetch(`/api/web/${path}`, {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'network', '连接中断或请求超时，请重试。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof data?.error === 'object' ? data.error : data;
    throw new ApiError(response.status, String(detail?.code ?? data?.error ?? ''), '操作未完成。');
  }
  if (!data?.result || typeof data.result !== 'object') throw new ApiError(502, 'invalid_result', '无法读取操作结果。');
  return data.result;
}

export const read = <T>(id: string, input: Record<string, unknown>, signal: AbortSignal) =>
  request('invoke', operation(id, input), signal) as Promise<T>;
export const write = <T>(call: OperationCall) => request('invoke', call) as Promise<T>;
export async function recover<T>(call: OperationCall): Promise<T> {
  try { return await request('receipt', { operationId: call.operationId, stepId: call.stepId }) as T; }
  catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'operation_receipt_not_found') return write<T>(call);
    throw error;
  }
}

export async function all<T>(id: string, input: Record<string, unknown>, signal: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  for (;;) {
    const page = await read<{ items: T[] }>(id, { ...input, limit: 50, offset: items.length }, signal);
    if (!Array.isArray(page.items)) throw new ApiError(502, 'invalid_list', '无法读取列表。');
    items.push(...page.items);
    if (page.items.length < 50) return items;
  }
}

export function href(path: string, params: Record<string, string | number | undefined | null> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  return path + (query.size ? `?${query}` : '');
}
export const recordHref = (kind: string, id: string, revision?: number) => href(`/${kind}/${encodeURIComponent(id)}`, { revision });
export const version = (revision: number) => `第 ${revision} 版`;
export const draftKey = (draft: { draftId: string; revision: number }) => `${draft.draftId}@${draft.revision}`;

export function revisionParam(params: URLSearchParams, key = 'revision'): number | undefined {
  if (!params.has(key)) return;
  const raw = params.getAll(key);
  const value = Number(raw[0]);
  if (raw.length !== 1 || !/^\d+$/.test(raw[0] ?? '') || !Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, 'invalid_revision', '版本地址无效，请从版本记录重新选择。');
  }
  return value;
}
export function requiredId(value: string | null): string {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ApiError(400, 'invalid_id', '请先选择所属场景。');
  return value;
}
export function message(error: unknown): string {
  if (!(error instanceof ApiError)) return '暂时无法完成操作，请重试。';
  if (error.status === 404) return '找不到这条记录或指定版本，请返回已有内容重新选择。';
  if (error.status === 409) return '内容已有更新。请读取最新版本，核对后再次确认。';
  if (error.status === 401 || error.status === 403) return '当前无法访问，请检查登录状态和访问地址。';
  if (error.code === 'invalid_revision' || error.code === 'invalid_id' || error.status === 0) return error.message;
  if (error.status === 400 || error.status === 422) return '请检查正文、标题和引用版本后重试。';
  return '读取或保存失败，请重试。';
}
