import { ApiError, invoke, operation } from '../api.ts';

export interface RecentManuscript {
  kind: 'draft' | 'scene' | 'diary';
  id: string;
  title: string;
  href: string;
  sceneId?: string;
  updatedAt: number;
}

const key = 'sth:manuscripts:recent:v1';
const paths = { draft: 'drafts', scene: 'scenes', diary: 'diaries' };

function valid(value: unknown): value is RecentManuscript {
  if (!value || typeof value !== 'object') return false;
  const item = value as RecentManuscript;
  if (!Object.hasOwn(paths, item.kind) || typeof item.id !== 'string' || typeof item.title !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0 ||
      !Number.isFinite(new Date(item.updatedAt).getTime()) || typeof item.href !== 'string' ||
      (item.sceneId !== undefined && (typeof item.sceneId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.sceneId)))) return false;
  try {
    const url = new URL(item.href, location.origin);
    return url.origin === location.origin &&
      url.pathname === `/${paths[item.kind]}/${encodeURIComponent(item.id)}`;
  } catch { return false; }
}

export function recentManuscripts(): RecentManuscript[] {
  try {
    const items: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(items) ? items.filter(valid).slice(0, 40) : [];
  } catch { return []; }
}

export async function loadRecentManuscripts(local: RecentManuscript[], signal: AbortSignal) {
  const saved = local.filter(valid);
  let remote: RecentManuscript[] = [];
  let incomplete = false;
  try {
    const result = await invoke<{ items: RecentManuscript[] }>(operation('manuscript.recent', { limit: 40 }), signal);
    if (!Array.isArray(result.items) || !result.items.every(valid)) {
      throw new ApiError(502, 'invalid_recent_manuscripts', '最近写过的文稿暂时无法读取，请重试。');
    }
    remote = result.items;
  } catch (error) {
    if (signal.aborted || !saved.length) throw error;
    incomplete = true;
  }
  const merged = new Map(remote.map(item => [`${item.kind}:${item.id}`, item]));
  for (const item of saved.toSorted((a, b) => a.updatedAt - b.updatedAt)) {
    const key = `${item.kind}:${item.id}`;
    const server = merged.get(key);
    // Local reader links retain their revision, selected passage and editing state.
    const pinned = new URL(item.href, location.origin).searchParams.has('revision');
    merged.set(key, { ...server, ...item,
      title: !pinned && server && server.updatedAt > item.updatedAt ? server.title : item.title,
      ...(server?.sceneId ? { sceneId: server.sceneId } : {}),
      updatedAt: Math.max(server?.updatedAt ?? 0, item.updatedAt),
    });
  }
  const seen = new Set<string>();
  const items = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).filter(item => {
    const key = item.kind === 'diary' ? `diary:${item.id}` : `scene:${item.sceneId ?? item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { items, incomplete };
}

export function rememberManuscript(record: Omit<RecentManuscript, 'updatedAt'>, fromReader = false) {
  const item = { ...record, updatedAt: Date.now() };
  if (!valid(item)) return;
  // Collection views can show a first sheet automatically without the author opening it.
  if (fromReader && new URL(item.href, location.origin).pathname !== location.pathname) return;
  const remaining = recentManuscripts().filter(other => other.id !== item.id || other.kind !== item.kind);
  try { localStorage.setItem(key, JSON.stringify([item, ...remaining].slice(0, 40))); }
  catch { return; }
  window.dispatchEvent(new Event('sth:manuscripts-changed'));
}
