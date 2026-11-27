import type { Draft, DraftRef, Scene, SceneSummary } from '../../src/story/contracts.ts';
import type { Diary, Project } from '../workspace/api.ts';
import { all, href, read, recordHref } from '../workspace/api.ts';
import { revisionParam, type DraftSummary } from '../writing/api.ts';
import { loadRecentManuscripts } from './recent.ts';
import { collectionRoute } from './routes.ts';

export type { Project };
export type LibraryPreviewReason = 'empty' | 'searching' | 'no-matches' | 'search-incomplete' | 'unavailable';
export interface LibraryChapter {
  chapterId: string;
  projectId: string;
  title: string;
  position: number;
  sceneCount: number;
}
export interface RecentManuscript {
  kind: 'draft' | 'scene' | 'diary';
  id: string;
  title: string;
  href: string;
  sceneId?: string;
  updatedAt: number;
}
export interface LibraryContext {
  shelf: 'recent' | 'diaries' | 'project' | 'unplaced';
  projectId?: string;
  chapterId?: string;
  allPath?: '/create' | '/projects';
  sceneId?: string;
  selectedSceneId?: string;
  noteId?: string;
  draft?: Draft;
  scene?: Scene;
  section?: 'characters' | 'sources';
}
export interface LibrarySheet {
  key: string;
  kind: 'scene' | 'diary';
  id: string;
  title: string;
  href: string;
  preview: string;
  searchText: string;
  status: string;
  projectId?: string;
  chapterId?: string;
  position?: number;
  diaryDate?: string;
  updatedAt?: number;
  unavailable?: boolean;
  needsCandidate?: boolean;
}

const identity = /^[A-Za-z0-9_-]{1,128}$/;
const collator = new Intl.Collator('zh-CN', { numeric: true });

function routeId(path: string, resource: string): string | undefined {
  const match = new RegExp(`^/${resource}/([^/]+)/?$`).exec(path);
  if (!match || match[1] === 'new') return;
  let id: string;
  try { id = decodeURIComponent(match[1]!); } catch { throw new Error('invalid route'); }
  if (!identity.test(id)) throw new Error('invalid route');
  return id;
}

function allManuscriptsPath(url: URL) {
  if (url.search) return;
  if (/^\/create\/?$/.test(url.pathname)) return '/create' as const;
  if (/^\/projects\/?$/.test(url.pathname)) return '/projects' as const;
}

function originatingShelf(url: URL, scene: Scene): LibraryContext | undefined {
  try {
    let source = url;
    // Candidate switching can return through a scene before reaching its list.
    for (let depth = 0; depth < 8; depth++) {
      const raw = source.searchParams.get('returnTo');
      if (!raw) return;
      source = new URL(raw, url);
      if (source.origin !== url.origin || source.searchParams.has('view') || source.searchParams.has('q')) return;
      const sourceSceneId = routeId(source.pathname, 'scenes');
      if (sourceSceneId) {
        if (sourceSceneId !== scene.sceneId) return;
        continue;
      }
      if (routeId(source.pathname, 'drafts')) continue;
      const allPath = allManuscriptsPath(source);
      if (allPath) return { shelf: 'project', allPath, projectId: undefined, chapterId: undefined };
      const projectId = routeId(source.pathname, 'projects');
      if (!projectId) return;
      const shelf = source.searchParams.get('shelf');
      const chapterId = source.searchParams.get('chapterId') || undefined;
      if (chapterId && !identity.test(chapterId)) return;
      if (shelf === 'unplaced') {
        if (!scene.placement && !chapterId) return { shelf: 'unplaced', projectId };
        return;
      }
      if (shelf || scene.placement?.projectId !== projectId
        || (chapterId && scene.placement.chapterId !== chapterId)) return;
      return { shelf: 'project', projectId, chapterId };
    }
  } catch { /* Old or stale return links recover through the scene's actual placement. */ }
}

export async function resolveLibraryContext(url: URL, signal: AbortSignal): Promise<LibraryContext> {
  const draftId = routeId(url.pathname, 'drafts');
  let sceneId = routeId(url.pathname, 'scenes');
  let draft: Draft | undefined;
  if (draftId) {
    const revision = revisionParam(url.searchParams);
    draft = await read<Draft>('draft.read', { draftId, ...(revision ? { revision } : {}) }, signal);
    sceneId = draft.sceneId;
  }
  if (sceneId) {
    const revision = draft ? undefined : revisionParam(url.searchParams);
    const scene = await read<Scene>('scene.read', { sceneId, ...(revision ? { revision } : {}) }, signal);
    return {
      shelf: scene.placement ? 'project' : 'unplaced',
      projectId: scene.placement?.projectId,
      chapterId: scene.placement?.chapterId,
      ...originatingShelf(url, scene),
      sceneId, scene, draft,
    };
  }
  if (/^\/diaries(?:\/|$)/.test(url.pathname)) {
    return { shelf: 'diaries', noteId: routeId(url.pathname, 'diaries'), projectId: url.searchParams.get('projectId') || undefined };
  }
  const projectId = routeId(url.pathname, 'projects') ?? url.searchParams.get('projectId') ?? undefined;
  if (projectId) {
    if (!identity.test(projectId)) throw new Error('invalid project');
    const chapterId = url.searchParams.get('chapterId') || undefined;
    if (chapterId && !identity.test(chapterId)) throw new Error('invalid chapter');
    const selected = url.searchParams.get('selected');
    return {
      shelf: url.searchParams.get('shelf') === 'unplaced' ? 'unplaced' : 'project', projectId, chapterId,
      selectedSceneId: selected && identity.test(selected) ? selected : undefined,
      section: /^\/characters(?:\/|$)/.test(url.pathname) ? 'characters'
        : /^\/sources(?:\/|$)/.test(url.pathname) ? 'sources' : undefined,
    };
  }
  if (/^\/(projects|create)\/?$/.test(url.pathname)) return { shelf: 'project', allPath: allManuscriptsPath(url) };
  return { shelf: 'recent' };
}

export function isLibraryCollection(url: URL): boolean {
  return /^\/(projects|create|diaries)\/?$/.test(url.pathname)
    || /^\/projects\/(?!new\/?$)[^/]+\/?$/.test(url.pathname)
    || (/^\/workspace\/?$/.test(url.pathname) && url.searchParams.get('tab') === 'recent');
}

export function libraryCollectionTitle(url: URL, projects: Project[], chapters: LibraryChapter[]): string | undefined {
  if (!collectionRoute(url)) return;
  if (/^\/(projects|create)\/?$/.test(url.pathname)) return '资料库 · Sth';
  if (/^\/diaries\/?$/.test(url.pathname)) return '日记 · Sth';
  if (/^\/workspace\/?$/.test(url.pathname)) return '最近写过 · Sth';
  let projectId: string | undefined;
  try { projectId = routeId(url.pathname, 'projects'); } catch { return '作品 · Sth'; }
  const project = projects.find(item => item.projectId === projectId);
  const projectTitle = project?.title ?? '作品';
  if (url.searchParams.get('shelf') === 'unplaced') return `未编入章节 · ${projectTitle} · Sth`;
  const chapterId = url.searchParams.get('chapterId');
  if (chapterId) {
    const chapter = chapters.find(item => item.chapterId === chapterId && item.projectId === projectId);
    return `${chapter?.title ?? '章节'} · ${projectTitle} · Sth`;
  }
  return `${projectTitle} · Sth`;
}

export const projectShelfHref = (projectId: string, chapterId?: string) =>
  href(recordHref('projects', projectId), { chapterId });
export const unplacedShelfHref = (projectId: string) =>
  href(recordHref('projects', projectId), { shelf: 'unplaced' });

export function libraryCollectionHref(context: LibraryContext, selectedSceneId?: string): string | undefined {
  if (context.allPath) return context.allPath;
  if (!context.projectId || !['project', 'unplaced'].includes(context.shelf)) return;
  return href(recordHref('projects', context.projectId), {
    ...(context.shelf === 'unplaced' ? { shelf: 'unplaced' } : { chapterId: context.chapterId }),
    selected: selectedSceneId,
  });
}

export function librarySheetHref(sheet: LibrarySheet, context: LibraryContext, origin: URL): string {
  const returnTo = libraryCollectionHref(context, sheet.id);
  if (!returnTo || sheet.kind !== 'scene') return sheet.href;
  const destination = new URL(sheet.href, origin);
  destination.searchParams.set('returnTo', returnTo);
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

export function shelfKey(context: LibraryContext): string {
  if (context.shelf === 'diaries') return `diaries:${context.projectId ?? ''}`;
  return `${context.shelf}:${context.projectId ?? ''}:${context.chapterId ?? ''}`;
}

export function chapterOrder(chapters: LibraryChapter[]): LibraryChapter[] {
  return [...chapters].sort((a, b) => a.position - b.position || collator.compare(a.chapterId, b.chapterId));
}

export function orderedSheets(sheets: LibrarySheet[], context: LibraryContext, chapters: LibraryChapter[]): LibrarySheet[] {
  const positions = new Map(chapters.map(chapter => [chapter.chapterId, chapter.position]));
  return [...sheets].sort((a, b) => {
    if (context.shelf === 'recent') return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    if (context.shelf === 'diaries') return (b.diaryDate ?? '').localeCompare(a.diaryDate ?? '') || collator.compare(a.id, b.id);
    return collator.compare(a.projectId ?? '\uffff', b.projectId ?? '\uffff')
      || (positions.get(a.chapterId ?? '') ?? Infinity) - (positions.get(b.chapterId ?? '') ?? Infinity)
      || (a.position ?? Infinity) - (b.position ?? Infinity) || collator.compare(a.title, b.title) || collator.compare(a.id, b.id);
  });
}

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('zh-CN');
export function matchesSheet(sheet: LibrarySheet, query: string, chapters: LibraryChapter[]): boolean {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const chapter = chapters.find(item => item.chapterId === sheet.chapterId)?.title ?? '';
  const haystack = normalize(`${sheet.title}\n${sheet.searchText}\n${chapter}\n${sheet.diaryDate ?? ''}`);
  return terms.every(term => haystack.includes(term));
}

function excerpt(text: string) { return text.replace(/\s+/g, ' ').trim().slice(0, 240); }

export function isAdoptedDraft(draft: DraftRef, adopted?: DraftRef) {
  return draft.draftId === adopted?.draftId && draft.revision === adopted.revision;
}

export function draftSheetContent(draft: Draft, adopted: boolean | undefined) {
  const label = adopted === undefined ? '稿件' : adopted ? '采用稿' : '候选稿';
  return { preview: excerpt(draft.body), status: `${label} · ${draft.title} · 第 ${draft.revision} 版` };
}

function sceneSheet(scene: SceneSummary | Scene): LibrarySheet {
  const adopted = 'characters' in scene ? scene.adopted : undefined;
  const context = [scene.time, scene.place].filter(Boolean).join(' · ');
  return {
    key: `scene:${scene.sceneId}`, kind: 'scene', id: scene.sceneId, title: scene.title,
    href: recordHref('scenes', scene.sceneId, adopted ? scene.revision : undefined),
    ...(adopted ? draftSheetContent(adopted, true) : { preview: excerpt(context), status: scene.adopted ? '采用稿' : '尚无稿件' }),
    searchText: `${adopted?.body ?? ''}\n${context}`,
    projectId: scene.placement?.projectId, chapterId: scene.placement?.chapterId, position: scene.placement?.position,
  };
}

export async function loadCandidateSummary(sheet: LibrarySheet, signal: AbortSignal): Promise<LibrarySheet> {
  const base = { ...sheet, needsCandidate: false, status: '尚无稿件' };
  try {
    const { items: [first] } = await read<{ items: DraftSummary[] }>('draft.list', { sceneId: sheet.id, limit: 1 }, signal);
    if (!first) return base;
    const draft = await read<Draft>('draft.read', { draftId: first.draftId, revision: first.revision }, signal);
    return {
      ...base, ...draftSheetContent(draft, false), href: recordHref('drafts', draft.draftId, draft.revision),
      searchText: `${draft.body}\n${sheet.searchText}`,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ...base, unavailable: true, status: '摘要暂时无法读取' };
  }
}

function diarySheet(diary: Diary): LibrarySheet {
  return {
    key: `diary:${diary.noteId}`, kind: 'diary', id: diary.noteId, title: diary.title,
    href: recordHref('diaries', diary.noteId), preview: diary.body.replace(/\s+/g, ' ').trim().slice(0, 240),
    searchText: `${diary.body}\n${diary.character?.name ?? ''}`, diaryDate: diary.diaryDate,
    status: diary.character?.name ?? '日记', projectId: diary.projectId,
  };
}

// Bound detail requests while preserving the server's manuscript order.
async function mapDetails<T, R>(items: T[], signal: AbortSignal, readItem: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      signal.throwIfAborted();
      const index = next++;
      result[index] = await readItem(items[index]!);
    }
  }));
  return result;
}

function recentHref(item: RecentManuscript, origin: URL): string {
  const path = recordHref(item.kind === 'diary' ? 'diaries' : `${item.kind}s`, item.id);
  try {
    const url = new URL(item.href, origin);
    if (url.origin === origin.origin && url.pathname.replace(/\/$/, '') === path) return `${url.pathname}${url.search}${url.hash}`;
  } catch { /* A stale local link can still recover through its resource ID. */ }
  return path;
}

async function loadRecentSheets(recent: RecentManuscript[], url: URL, signal: AbortSignal) {
  const result = await loadRecentManuscripts(recent, signal);
  const entries = result.items;
  const items = await mapDetails(entries, signal, async item => {
    const link = recentHref(item, url);
    try {
      const revision = revisionParam(new URL(link, url).searchParams);
      const version = revision ? { revision } : {};
      let sheet: LibrarySheet;
      if (item.kind === 'diary') {
        sheet = diarySheet(await read<Diary>('diary.read', { noteId: item.id, ...version }, signal));
      } else if (item.kind === 'draft') {
        const draft = await read<Draft>('draft.read', { draftId: item.id, ...version }, signal);
        const scene = await read<{ items: SceneSummary[] }>('scene.revisions', { sceneId: draft.sceneId, limit: 1 }, signal)
          .then(result => result.items[0], error => { if (signal.aborted) throw error; });
        sheet = {
          key: `scene:${draft.sceneId}`, kind: 'scene', id: draft.sceneId, title: item.title || draft.title,
          href: link, ...draftSheetContent(draft, scene ? isAdoptedDraft(draft, scene.adopted) : undefined), searchText: draft.body,
        };
      } else {
        sheet = sceneSheet(await read<Scene>('scene.read', { sceneId: item.id, ...version }, signal));
      }
      return { ...sheet, href: link, updatedAt: item.updatedAt };
    } catch (error) {
      if (signal.aborted) throw error;
      const sceneId = item.sceneId && identity.test(item.sceneId) ? item.sceneId : undefined;
      const kind = item.kind === 'diary' ? 'diary' : 'scene';
      return {
        key: `${kind}:${sceneId ?? item.id}`, kind, id: sceneId ?? item.id, title: item.title,
        href: link, preview: '', searchText: '', status: '内容暂时无法读取', updatedAt: item.updatedAt, unavailable: true,
      } satisfies LibrarySheet;
    }
  });
  const seen = new Set<string>();
  return {
    items: items.filter(item => { if (seen.has(item.key)) return false; seen.add(item.key); return true; }),
    incomplete: result.incomplete || items.some(item => item.unavailable),
  };
}

export async function loadLibrarySheets(context: LibraryContext, recent: RecentManuscript[], url: URL, signal: AbortSignal) {
  if (context.shelf === 'diaries') {
    const diaries = await all<Diary>('diary.list', context.projectId ? { projectId: context.projectId } : {}, signal);
    return { items: diaries.map(diarySheet), incomplete: false };
  }
  if (context.shelf === 'recent') return loadRecentSheets(recent, url, signal);
  // Unplaced scenes have no project ownership in the operation contract.
  const filter = context.shelf === 'unplaced' ? { chapterId: null }
    : { projectId: context.projectId, ...(context.chapterId ? { chapterId: context.chapterId } : {}) };
  const summaries = await all<SceneSummary>('scene.list', filter, signal);
  let incomplete = false;
  const items = await mapDetails(summaries, signal, async summary => {
    if (!summary.adopted) return { ...sceneSheet(summary), needsCandidate: true, status: '尚无采用稿' };
    try {
      const detail = context.scene?.sceneId === summary.sceneId && context.scene.revision === summary.revision
        ? context.scene : await read<Scene>('scene.read', { sceneId: summary.sceneId, revision: summary.revision }, signal);
      return sceneSheet(detail);
    } catch (error) {
      if (signal.aborted) throw error;
      incomplete = true;
      return { ...sceneSheet(summary), unavailable: true, status: '摘要暂时无法读取' };
    }
  });
  return { items, incomplete };
}
