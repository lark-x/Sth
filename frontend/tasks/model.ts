import { ApiError, display, inputFor, internalHref, listAll, literals, read } from './legacy.js';
import type { Catalog } from './legacy.js';

export interface Attempt {
  number: number;
  provider: string;
  providerJobId?: string;
  requestId: string;
  message?: string;
  updatedAt: string;
  parameters: Record<string, string | number | boolean>;
}
export interface ScenePin { sceneId: string; revision: number; title: string }
export interface JobItem {
  itemId: string;
  compositionId: string;
  title: string;
  scene: ScenePin;
  status: string;
  attempt?: Attempt;
  mediaId?: string;
  reconciliationQueued: boolean;
}
export interface Job {
  jobId: string;
  projectId: string;
  title: string;
  mode: string;
  maxImages?: number;
  attemptsStarted: number;
  createdAt: string;
  progress: Record<string, number>;
  items: JobItem[];
}
export interface Media {
  mediaId: string;
  jobId: string;
  compositionId: string;
  title: string;
  contentHref: string;
  contentType: string;
  width: number;
  height: number;
  byteLength: number;
  createdAt: string;
  scene: ScenePin;
  attempt: Attempt;
}
export interface TaskRow { id: string; href: string; title: string; kind: string; status: string; createdAt: string }
export interface Filter { key: string; label: string; value: string; choices?: [string, string][]; maxLength?: number }
export interface TaskList { items: TaskRow[]; nextOffset?: number; offset: number; filters: Filter[] }

const invalid = () => new ApiError(502, '', '服务返回的任务或媒体数据无法读取，请重试。');
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const scenePin = (value: unknown): value is ScenePin => object(value) && validId(value.sceneId) && positive(value.revision);
const attempt = (value: unknown): value is Attempt => object(value) && positive(value.number)
  && typeof value.provider === 'string' && typeof value.requestId === 'string' && typeof value.updatedAt === 'string'
  && object(value.parameters) && Object.values(value.parameters).every(item => ['string', 'number', 'boolean'].includes(typeof item));
const statuses = ['queued', 'submitting', 'submitted', 'unknown', 'failed', 'succeeded', 'canceled'];

export function jobRecord(value: unknown, id: string): Job {
  if (!object(value) || value.jobId !== id || typeof value.title !== 'string' || !object(value.progress)
    || !statuses.every(key => Number.isSafeInteger(value.progress[key]) && value.progress[key] >= 0)
    || !Array.isArray(value.items) || !value.items.every(item => object(item) && validId(item.itemId)
      && validId(item.compositionId) && typeof item.title === 'string' && scenePin(item.scene) && statuses.includes(item.status)
      && (!item.attempt || attempt(item.attempt)) && (item.mediaId === undefined || validId(item.mediaId)))) throw invalid();
  return value as unknown as Job;
}

export function mediaRecord(value: unknown, id: string): Media {
  if (!object(value) || value.mediaId !== id || typeof value.title !== 'string' || !validId(value.jobId)
    || !validId(value.compositionId) || !scenePin(value.scene) || !attempt(value.attempt)
    || value.contentType !== 'image/png' || ![value.width, value.height, value.byteLength].every(positive)
    || internalHref(value.contentHref) !== `/api/web/media/${encodeURIComponent(id)}/content`) throw invalid();
  return value as unknown as Media;
}

export const sceneHref = (scene: ScenePin) => `/scenes/${encodeURIComponent(scene.sceneId)}?revision=${scene.revision}`;
export function downloadName(media: Media): string {
  const title = media.title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/[. ]+$/g, '').slice(0, 100);
  return `${title || media.mediaId}.png`;
}
export function dateText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
export function pageHref(url: URL, offset: number): string {
  const next = new URL(url.href);
  next.searchParams.set('offset', String(offset));
  return next.pathname + next.search + next.hash;
}

export async function loadTaskList(operations: Catalog, url: URL, signal: AbortSignal): Promise<TaskList> {
  const op = operations.has('tasks.list') ? 'tasks.list' : operations.has('jobs.list') ? 'jobs.list' : '';
  if (!op) throw new ApiError(404, '', '任务列表暂不可用。');
  const rules = operations.get(op)?.inputSchema?.properties ?? {};
  const params = url.searchParams;
  const requested = Number(params.get('offset'));
  const offset = Number.isSafeInteger(requested) && requested > 0 ? requested : 0;
  const filters: Filter[] = [];
  const input: Record<string, unknown> = { limit: 20, offset };
  for (const [key, list, identity, label] of [
    ['projectId', 'project.list', 'projectId', '项目'], ['sceneId', 'scene.list', 'sceneId', '场景'],
  ]) {
    if (!rules[key!]) continue;
    const records = await listAll(list!, {}, signal);
    const choices = records.map(record => [String(record[identity!]), String(record.title ?? record.name ?? record[identity!])] as [string, string]);
    const value = params.get(key!) ?? '';
    if (value && !choices.some(([id]) => id === value)) choices.push([value, value]);
    filters.push({ key: key!, label: label!, value, choices });
    input[key!] = value;
  }
  if (rules.kind) {
    const kinds = literals(rules.kind);
    const value = params.get('kind') ?? '';
    filters.push({ key: 'kind', label: '类型', value, choices: kinds.map(kind => [kind, display(kind)]) });
    input.kind = value;
  }
  const term = rules.query ? 'query' : rules.name ? 'name' : rules.title ? 'title' : '';
  if (term) {
    const value = params.get('q') ?? '';
    filters.push({ key: 'q', label: term === 'query' ? '关键词' : '完整名称', value, maxLength: rules[term]?.maxLength });
    input[term] = value.trim();
  }
  const result = await read(op, inputFor(operations, op, input), signal);
  if (!object(result) || !Array.isArray(result.items)) throw invalid();
  const items = result.items.map((row: unknown): TaskRow => {
    if (!object(row) || typeof row.title !== 'string' || typeof row.createdAt !== 'string') throw invalid();
    const href = internalHref(row.href);
    if (!href) throw invalid();
    if (op === 'tasks.list') {
      if (!validId(row.id) || typeof row.status !== 'string' || typeof row.kind !== 'string') throw invalid();
      return { id: row.id, title: row.title, href, status: row.status, kind: row.kind, createdAt: row.createdAt };
    }
    if (!validId(row.jobId) || !object(row.progress)) throw invalid();
    const status = statuses.filter(key => row.progress[key] > 0).map(key => `${display(key)} ${row.progress[key]}`).join(' · ');
    return { id: row.jobId, title: row.title, href, status, kind: 'media', createdAt: row.createdAt };
  });
  const nextOffset = op === 'tasks.list' ? result.nextOffset
    : rules.limit && rules.offset && items.length === 20 ? offset + 20 : undefined;
  if (nextOffset !== undefined && (!Number.isSafeInteger(nextOffset) || nextOffset <= offset)) throw invalid();
  return { items, nextOffset, offset, filters };
}
