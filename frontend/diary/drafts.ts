import { reactive } from 'vue';
import type { Call, Character, Diary, SourcePin } from './api';

export interface Values {
  title: string;
  body: string;
  diaryDate: string;
  projectId: string;
  characterId: string;
  sourcePins: SourcePin[];
}

export interface Draft {
  values: Values;
  initial: Values;
  record?: Diary;
  character?: Character;
  busy: boolean;
  uncertain: boolean;
  conflict: boolean;
  error: string;
  call?: Call;
  saved?: Diary;
}

const drafts = new Map<string, Draft>();
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const dirty = (draft: Draft) => draft.busy || Boolean(draft.call) || !same(draft.values, draft.initial);

function warn(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = '';
}

export function updateWarning() {
  if ([...drafts.values()].some(dirty)) window.addEventListener('beforeunload', warn);
  else window.removeEventListener('beforeunload', warn);
}

export function getDraft(key: string, values: Values, record?: Diary, character?: Character): Draft {
  const retained = drafts.get(key);
  if (retained && dirty(retained)) return retained;
  const draft = reactive<Draft>({ values: copy(values), initial: copy(values), record, character,
    busy: false, uncertain: false, conflict: false, error: '' });
  drafts.set(key, draft);
  return draft;
}

export function forgetDraft(key: string) {
  drafts.delete(key);
  updateWarning();
}

export function valuesFor(record: Diary): Values {
  return { title: record.title, body: record.body, diaryDate: record.diaryDate,
    projectId: record.projectId ?? '', characterId: record.character?.characterId ?? '',
    sourcePins: (record.sourcePins ?? []).map(({ sourceId, revision, excerpt, range }) =>
      ({ sourceId, revision, excerpt, ...(range ? { range: copy(range) } : {}) })),
  };
}

export function today(): string {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

export function dateLabel(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(+date) ? new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  }).format(date) : value;
}

export function resourceHref(section: string, id: string, revision?: number, range?: SourcePin['range']): string {
  const params = new URLSearchParams();
  if (revision) params.set('revision', String(revision));
  if (range) { params.set('start', String(range.start)); params.set('end', String(range.end)); }
  return `/${section}/${encodeURIComponent(id)}${params.size ? `?${params}` : ''}`;
}

export function indexHref(projectId?: string): string {
  return projectId ? `/?${new URLSearchParams({ projectId })}` : '/diaries';
}
