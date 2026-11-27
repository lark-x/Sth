export interface DiarySummary {
  noteId: string;
  href: string;
  title: string;
  body: string;
  diaryDate: string;
  revision: number;
  projectId?: string;
  character?: { characterId: string; name: string; revision: number };
}

export interface OperationCall {
  operationId: string;
  stepId: string;
  input: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function operation(operationId: string, input: Record<string, unknown>): OperationCall {
  return { operationId, stepId: `web:${crypto.randomUUID()}`, input };
}

export async function invoke<T>(call: OperationCall, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetch('/api/web/invoke', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(call),
      cache: 'no-store',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'network', timeout.aborted ? '请求超时，请重试。' : '无法连接本地服务，请检查连接后重试。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, data?.code || data?.error || '',
      response.status === 401 || response.status === 403
        ? '当前无法访问，请检查 Sth 的访问地址和登录状态。'
        : '保存或读取失败，请重试。');
  }
  if (!data || !data.result || typeof data.result !== 'object') {
    throw new ApiError(502, 'invalid_result', '服务返回的数据无法读取，请重试。');
  }
  return data.result as T;
}

export function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : '暂时无法读取，请重试。';
}

export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
