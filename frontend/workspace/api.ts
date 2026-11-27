import { ApiError, invoke, operation } from '../api.ts';
import type { OperationCall } from '../api.ts';

export { ApiError };
export interface Project { projectId: string; title: string }
export interface Version { revision: number }
export interface Character extends Version {
  characterId: string;
  name: string;
  persona: string;
  projectId?: string;
}
export interface SourcePin extends Version {
  sourceId: string;
  excerpt: string;
  range?: { start: number; end: number };
}
export interface Source extends Version {
  sourceId: string;
  title: string;
  body: string;
  origin?: string;
}
export interface Diary extends Version {
  noteId: string;
  title: string;
  body: string;
  diaryDate: string;
  projectId?: string;
  character?: Pick<Character, 'characterId' | 'revision' | 'name'>;
  sourcePins?: SourcePin[];
}
export interface Draft extends Version { draftId: string; title: string; body?: string }
export interface Scene extends Version {
  sceneId: string;
  title: string;
  time?: string;
  place?: string;
  placement?: { projectId: string; chapterId: string; position: number };
  characters: Character[];
  sources: SourcePin[];
  adopted?: Draft;
}
export interface Chapter { chapterId: string; title: string; revision: number; sceneCount: number }
export interface Narrative extends Version { narrativeId: string; title: string }
export interface Branch extends Version { branchId: string; name: string }
export interface Page<T> { items: T[]; more: boolean }
export type StartContext =
  | { kind: 'character'; record: Character }
  | { kind: 'source'; record: Source; range?: { start: number; end: number } }
  | { kind: 'diary'; record: Diary };

export const read = <T>(id: string, input: Record<string, unknown>, signal: AbortSignal) =>
  invoke<T>(operation(id, input), signal);

export async function pageOf<T>(id: string, filters: Record<string, unknown>, signal: AbortSignal, offset = 0): Promise<Page<T>> {
  const data = await read<{ items: T[] }>(id, { ...filters, limit: 20, offset }, signal);
  if (!Array.isArray(data.items)) throw new ApiError(502, 'invalid_list', '列表读取失败，请重试。');
  return { items: data.items, more: data.items.length === 20 };
}

export async function all<T>(id: string, filters: Record<string, unknown>, signal: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  for (;;) {
    const page = await pageOf<T>(id, filters, signal, items.length);
    items.push(...page.items);
    if (!page.more) return items;
  }
}

export function href(path: string, params: Record<string, string | number | undefined> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value));
  return path + (query.size ? `?${query}` : '');
}

export const recordHref = (kind: string, id: string, revision?: number) => href(`/${kind}/${encodeURIComponent(id)}`, { revision });
export const sourceHref = (pin: SourcePin) => href(recordHref('sources', pin.sourceId), {
  revision: pin.revision, start: pin.range?.start, end: pin.range?.end,
});
export const startHref = (kind: string, id: string, revision: number) => href('/workspace', {
  tab: 'continue', from: kind, [`${kind === 'diary' ? 'note' : kind}Id`]: id, revision,
});

export function message(error: unknown): string {
  if (!(error instanceof ApiError)) return '读取失败，请重试。';
  if (error.status === 404) return '找不到这条记录或指定版本，请返回选择已有内容。';
  if (error.status === 400 || error.status === 422) return '内容未能保存，请检查名称、正文或引用版本后重试。';
  return error.message || '服务暂时无法处理，请重试。';
}

// Use the existing operation receipt before replaying an uncertain write.
export async function recover<T>(call: OperationCall): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/web/receipt', {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: call.operationId, stepId: call.stepId }), signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(0, 'network', '尚未确认保存结果，请重试同一次提交。');
  }
  const data = await response.json().catch(() => null);
  const code = typeof data?.error === 'object' ? data.error?.code : data?.code ?? data?.error;
  if (response.status === 404 && code === 'operation_receipt_not_found') return invoke<T>(call);
  if (!response.ok) throw new ApiError(response.status, String(code ?? ''), '尚未确认保存结果，请重试同一次提交。');
  if (!data?.result || typeof data.result !== 'object') throw new ApiError(502, 'invalid_receipt', '保存回执无法读取，请重试同一次提交。');
  return data.result as T;
}
