export interface SourcePin {
  sourceId: string;
  revision: number;
  excerpt: string;
  range?: { start: number; end: number };
}

export interface Diary {
  noteId: string;
  title: string;
  body: string;
  diaryDate: string;
  revision: number;
  href: string;
  projectId?: string;
  character?: { characterId: string; name: string; revision: number };
  sourcePins?: SourcePin[];
}

export interface Project { projectId: string; title: string }
export interface Character {
  characterId: string;
  name: string;
  persona?: string;
  revision: number;
  projectId?: string;
}
export interface Source { sourceId: string; title: string; revision: number; body?: string }
export interface Backlink {
  characterId: string;
  revision: number;
  name: string;
  entryId: string;
  blockIndex: number;
  label: string;
  reference: { excerpt?: string };
}
interface Schema {
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  properties?: Record<string, Schema>;
  items?: Schema;
}
export interface Operation { id: string; inputSchema: Schema }
export interface Call { operationId: string; stepId: string; input: Record<string, unknown> }

export class ApiError extends Error {
  constructor(public status: number, public code = '', message = '') { super(message); }
  get uncertain() { return this.status === 0 || this.status === 408 || this.status >= 500; }
  get conflict() { return this.status === 409 && (!this.code || this.code.includes('revision_conflict')); }
}

async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetch(`/api/web${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: 'application/json' } : {
        Accept: 'application/json', 'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, '', timeout.aborted ? '请求超时。' : '无法连接本地服务。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const details = typeof data?.error === 'object' ? data.error : data;
    throw new ApiError(response.status, details?.code ?? data?.error ?? '', details?.message);
  }
  if (!data || typeof data !== 'object') throw new ApiError(502, '', '服务返回的数据无法读取。');
  return data;
}

export function step(operationId: string, input: Record<string, unknown>): Call {
  return { operationId, stepId: `web:${crypto.randomUUID()}`, input };
}

export async function invoke<T>(call: Call, signal?: AbortSignal): Promise<T> {
  const data = await request('/invoke', call, signal);
  if (!data.result || typeof data.result !== 'object') throw new ApiError(502, '', '服务未返回操作结果。');
  return data.result as T;
}

export const read = <T>(operationId: string, input: Record<string, unknown>, signal?: AbortSignal) =>
  invoke<T>(step(operationId, input), signal);

export async function retryWrite<T>(call: Call): Promise<T> {
  try {
    const data = await request('/receipt', { operationId: call.operationId, stepId: call.stepId });
    if (!data.result || typeof data.result !== 'object') throw new ApiError(502, '', '服务未返回操作回执。');
    return data.result as T;
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'operation_receipt_not_found') throw error;
    return invoke<T>(call);
  }
}

export async function catalog(signal: AbortSignal): Promise<Map<string, Operation>> {
  const data = await request('/catalog', undefined, signal);
  if (!Array.isArray(data.operations)) throw new ApiError(502, '', '服务未返回操作目录。');
  return new Map((data.operations as Operation[]).map(operation => [operation.id, operation]));
}

export async function listAll<T>(operations: Map<string, Operation>, operationId: string,
  filters: Record<string, unknown>, signal: AbortSignal): Promise<T[]> {
  const properties = operations.get(operationId)?.inputSchema.properties;
  const canPage = Boolean(properties?.limit && properties.offset);
  const limit = Math.min(properties?.limit?.maximum ?? 20, 20);
  const result: T[] = [];
  for (;;) {
    const data = await read<{ items: T[] }>(operationId,
      canPage ? { ...filters, limit, offset: result.length } : filters, signal);
    if (!Array.isArray(data.items)) throw new ApiError(502, '', '服务未返回列表。');
    result.push(...data.items);
    if (!canPage || data.items.length < limit) return result;
  }
}

export function revision(record: { revision: number }): number {
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new ApiError(502, '', '服务未返回有效版本。');
  return record.revision;
}

export function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return '操作失败，请重试。';
  if (error.status === 404) return '找不到这条记录。';
  if (error.status === 401 || error.status === 403) return '当前无法访问，请检查 Sth 的访问地址和登录状态。';
  if (error.status === 429) return '请求过于频繁，请稍后重试。';
  if (error.code === 'invalid_revision') return '版本号无效，请使用正整数版本号。';
  if (error.code.includes('step_conflict')) return '保存请求编号发生冲突，请重新保存。';
  if (error.code === 'character_project_mismatch') return '这个角色归属另一个项目，请重新选择。';
  if (error.code === 'diary_date_invalid') return '请输入有效的日记日期。';
  if (error.code === 'source_excerpt_mismatch') return '引用原文与指定资料版本不符，请核对原文和位置。';
  if (error.code === 'library_invalid_text') return '请删除内容中的无效字符后重试。';
  if (error.status === 409) return '记录发生冲突，请检查内容。';
  if (error.status === 400 || error.status === 422) return '服务无法接受这些内容，请检查表单。';
  if (error.uncertain) return error.message || '本地服务处理失败，请重试。';
  return '操作失败，请重试。';
}
