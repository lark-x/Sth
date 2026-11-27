export { ApiError, catalog, errorText, invoke, listAll, read, retryWrite, step } from '../diary/api';
export type { Backlink as CharacterBacklink, Call, Character, Operation, Project } from '../diary/api';

export type SourceKind = 'setting' | 'inspiration' | 'excerpt';
export interface Range { start: number; end: number }
export interface Source {
  sourceId: string;
  revision: number;
  kind: SourceKind;
  title: string;
  body: string;
  href: string;
  projectIds: string[];
  origin?: string;
  external?: Record<string, unknown>;
}
export type Summary = Omit<Source, 'body'> & { matches?: Range[] };
export interface Backlink {
  owner: { kind: string; id: string; revision: number; title: string; href: string };
  pin: { sourceId: string; revision: number; excerpt: string; range?: Range; href: string };
  stance?: 'support' | 'counter';
}
export interface Impact {
  sourceRevision: number;
  kind: string;
  id: string;
  revision?: number;
  title: string;
  href: string;
  state: 'current' | 'historical' | 'snapshot';
  via: { kind: string; id: string; revision: number }[];
}
export const kinds = { setting: '设定', inspiration: '灵感', excerpt: '摘录' };
export const resourceNames: Record<string, string> = {
  judgment: '判断', event: '事件', narrative: '讲述', scene: '场景', draft: '候选稿',
  character: '角色', diary: '日记', generation: '生成记录',
};
const sections: Record<string, string> = {
  judgment: 'judgments', event: 'events', narrative: 'narratives', scene: 'scenes',
  draft: 'drafts', character: 'characters', diary: 'diaries', generation: 'generations',
};
export function href(id: string, revision?: number, range?: Range, extra: Record<string, unknown> = {}): string {
  return query(`/sources/${encodeURIComponent(id)}`, { revision, start: range?.start, end: range?.end, ...extra });
}
export function query(path: string, values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return path + (params.size ? `?${params}` : '');
}
export function resourceHref(kind: string, id: string, revision?: number): string {
  return query(`/${sections[kind] ?? kind}/${encodeURIComponent(id)}`, { revision });
}
export function localHref(value: string): string {
  return /^\/(?![\/\\])[^\s\\]*$/.test(value) ? value : '#';
}
export function integer(value: string | null, minimum = 0): number | undefined {
  if (!value || !/^\d+$/.test(value)) return;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : undefined;
}
export function rangeFrom(url: URL, body: string): Range | undefined {
  const start = integer(url.searchParams.get('start'));
  const end = integer(url.searchParams.get('end'));
  if (start !== undefined && end !== undefined && end > start && end <= body.length && body.slice(start, end).trim()) return { start, end };
}
