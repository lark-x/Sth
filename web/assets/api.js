const root = '/api/web';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = typeof code === 'string' ? code : '';
    this.uncertain = status === 0 || status === 408 || status >= 500;
    this.conflict = status === 409 && (!this.code || this.code.includes('revision_conflict'));
  }
}

async function request(path, { body, signal } = {}) {
  const timeout = AbortSignal.timeout(15000);
  if (signal) signal.throwIfAborted();
  let response;
  let data;
  try {
    response = await fetch(`${root}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: 'application/json' } : {
        Accept: 'application/json', 'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status === 204) return null;
    data = await response.json().catch(() => null);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, '', timeout.aborted ? '请求超时。' : '无法连接本地服务。');
  }
  if (!response.ok) {
    const details = typeof data?.error === 'object' ? data.error : data;
    throw new ApiError(response.status, details?.code ?? data?.error, details?.message);
  }
  if (!data || typeof data !== 'object') throw new ApiError(502, '', '服务返回的数据无法读取。');
  return data;
}

export function step(operationId, input) {
  return { operationId, stepId: `web:${crypto.randomUUID()}`, input };
}

export async function invoke(call, signal) {
  const data = await request('/invoke', { body: call, signal });
  if (!data?.result || typeof data.result !== 'object') {
    throw new ApiError(502, '', '服务未返回操作结果。');
  }
  return data.result;
}

export async function retryWrite({ operationId, stepId, input }) {
  try {
    const data = await request('/receipt', { body: { operationId, stepId } });
    if (data?.result && typeof data.result === 'object') return data.result;
    throw new ApiError(502, '', '服务未返回操作回执。');
  } catch (error) {
    if (error.code !== 'operation_receipt_not_found') throw error;
    return invoke({ operationId, stepId, input });
  }
}

export const read = (operationId, input, signal) => invoke(step(operationId, input), signal);

function items(data) {
  if (!Array.isArray(data?.items)) throw new ApiError(502, '', '服务未返回列表。');
  return data.items;
}

export const list = async (operationId, input, signal) => items(await read(operationId, input, signal));

export async function pager(operationId, filters, signal) {
  const operations = await catalog().catch(() => null);
  const properties = operations?.get(operationId)?.inputSchema?.properties;
  const canPage = properties?.limit && properties?.offset;
  const limit = Math.min(properties?.limit?.maximum ?? 20, 20);
  let offset = 0;
  return async () => {
    const records = await list(operationId, canPage ? { ...filters, limit, offset } : filters, signal);
    offset += records.length;
    return { records, more: Boolean(canPage && records.length === limit) };
  };
}

export async function listAll(operationId, filters, signal) {
  const next = await pager(operationId, filters, signal);
  const records = [];
  let page;
  do {
    page = await next();
    records.push(...page.records);
  } while (page.more);
  return records;
}

export function entity(result, id) {
  if (typeof result[id] !== 'string' || !result[id]) throw new ApiError(502, '', '服务未返回记录编号。');
  return result;
}

export function revision(record) {
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new ApiError(502, '', '服务未返回有效版本。');
  }
  return record.revision;
}

let catalogPromise;
export function catalog() {
  catalogPromise ??= request('/catalog').then(data => {
    if (!Array.isArray(data?.operations)) throw new ApiError(502, '', '服务未返回操作目录。');
    return new Map(data.operations.map(operation => [operation.id, operation]));
  }).catch(error => {
    catalogPromise = undefined;
    throw error;
  });
  return catalogPromise;
}

export const connections = async signal => items(await request('/connections', { signal }));
export const mediaProvider = signal => request('/providers/media', { signal });
export const issueCode = () => request('/connections/code', { body: {} });
export const revoke = id => request(`/connections/${encodeURIComponent(id)}/revoke`, { body: {} });

export function errorText(error) {
  if (!(error instanceof ApiError)) return '操作失败，请重试。';
  if (error.status === 404) return '找不到这条记录。';
  if (error.status === 401 || error.status === 403) return '当前无法访问，请检查 Sth 的访问地址和登录状态。';
  if (error.status === 429) return '请求过于频繁，请稍后重试。';
  if (error.code.includes('step_conflict')) return '保存请求编号发生冲突，请重新保存。';
  if (error.code === 'character_project_mismatch') return '这个角色归属另一个项目，请重新选择。';
  if (error.code === 'diary_date_invalid') return '请输入有效的日记日期。';
  if (error.code === 'library_invalid_text') return '请删除内容中的无效字符后重试。';
  if (error.status === 409) return '记录发生冲突，请检查内容。';
  if (error.status === 400 || error.status === 422) return '服务无法接受这些内容，请检查表单。';
  if (error.status === 0 || error.status === 502) return error.message;
  return '本地服务处理失败，请重试。';
}
