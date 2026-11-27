import { ApiError, read } from '../diary/api';
export { ApiError, catalog, errorText, listAll, revision } from '../diary/api';
export type { Operation, Project } from '../diary/api';
export type { AuthorEntry, CharacterBlock, CharacterEntry } from '../../src/library/character-contracts.ts';
import type { CharacterEntry } from '../../src/library/character-contracts.ts';

export interface Character {
  characterId: string;
  name: string;
  authorName?: string;
  persona: string;
  description?: string;
  entries: CharacterEntry[];
  projectId?: string;
  revision: number;
  href: string;
}
export interface Resource {
  revision: number;
  title?: string;
  name?: string;
  label?: string;
  [key: string]: unknown;
}
export type Choices = Record<string, [string, string, Resource][]>;
export const resources = {
  source: ['sources', '资料', 'sourceId'], scene: ['scenes', '场景', 'sceneId'],
  draft: ['drafts', '候选稿', 'draftId'], diary: ['diaries', '日记', 'noteId'],
  character: ['characters', '角色', 'characterId'], judgment: ['judgments', '判断', 'judgmentId'],
} as const;

export function query(path: string, values: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return path + (params.size ? `?${params}` : '');
}
export const href = (id: string, revision?: number) =>
  query(`/characters/${encodeURIComponent(id)}`, { revision });
export const assetHref = (id: string) => `/api/web/assets/${encodeURIComponent(id)}/content`;
export function referenceHref(block: { kind: keyof typeof resources; id: string; revision: number; range?: { start: number; end: number } }): string {
  return query(`/${resources[block.kind][0]}/${encodeURIComponent(block.id)}`,
    { revision: block.revision, start: block.range?.start, end: block.range?.end });
}
export async function readCharacter(id: string, signal: AbortSignal, revision?: number): Promise<Character> {
  const result = await read<Character>('character.read', { characterId: id, ...(revision ? { revision } : {}) }, signal);
  if (!result.characterId || !Array.isArray(result.entries) || !Number.isSafeInteger(result.revision) || result.revision < 1) {
    throw new ApiError(502, '', '服务未返回完整角色。');
  }
  return result;
}
