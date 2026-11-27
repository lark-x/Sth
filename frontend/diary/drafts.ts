import { effectScope, reactive, watch } from 'vue';
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

interface RetainedDraft {
  draft: Draft;
  owner: string;
  stored: string | null;
  stop: () => void;
}

const drafts = new Map<string, RetainedDraft>();
const prefix = 'sth:diary:draft:v1:';
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const dirty = (draft: Draft) => draft.busy || draft.conflict || Boolean(draft.call) || !same(draft.values, draft.initial);

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function pins(value: unknown): boolean {
  // Numeric inputs can be empty strings while the author is still editing.
  const numberInput = (input: unknown) => typeof input === 'number' || typeof input === 'string';
  return Array.isArray(value) && value.every(pin => object(pin) && typeof pin.sourceId === 'string' &&
    typeof pin.excerpt === 'string' && numberInput(pin.revision) &&
    (pin.range === undefined || (object(pin.range) && numberInput(pin.range.start) && numberInput(pin.range.end))));
}

function values(value: unknown): value is Values {
  return object(value) && ['title', 'body', 'diaryDate', 'projectId', 'characterId'].every(key => typeof value[key] === 'string') &&
    pins(value.sourcePins);
}

function versioned(value: unknown): value is Record<string, unknown> & { revision: number } {
  return object(value) && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0;
}

function restorable(value: unknown, record?: Diary): value is Draft {
  if (!object(value) || !values(value.values) || !values(value.initial)) return false;
  const base = value.record;
  if (record ? !versioned(base) || base.noteId !== record.noteId ||
    !['title', 'body', 'diaryDate', 'href'].every(key => typeof base[key] === 'string') ||
    (base.sourcePins !== undefined && !pins(base.sourcePins)) ||
    (base.character !== undefined && (!versioned(base.character) || typeof base.character.characterId !== 'string' || typeof base.character.name !== 'string'))
    : base !== undefined) return false;
  const character = value.character;
  if (character !== undefined && (!versioned(character) || character.characterId !== value.values.characterId ||
    typeof character.name !== 'string' || (character.persona !== undefined && typeof character.persona !== 'string'))) return false;
  const call = value.call;
  if (call === undefined) return true;
  if (!object(call) || call.operationId !== (record ? 'diary.revise' : 'diary.create') ||
    typeof call.stepId !== 'string' || !call.stepId || !object(call.input)) return false;
  const input = call.input;
  return ['title', 'body', 'diaryDate'].every(key => typeof input[key] === 'string') &&
    (!record || (input.noteId === record.noteId && input.expectedRevision === (base as Diary).revision));
}

export function ownsDraft(key: string, draft: Draft): boolean {
  const retained = drafts.get(key);
  if (retained?.draft !== draft) return false;
  // Another loaded copy can claim this route. Its snapshot must survive older requests.
  try { return sessionStorage.getItem(prefix + key) === retained.stored; }
  catch { return true; }
}

function persist(key: string, retained: RetainedDraft) {
  if (!ownsDraft(key, retained.draft)) return;
  const { values, initial, record, character, call, conflict } = retained.draft;
  try {
    const stored = dirty(retained.draft)
      ? JSON.stringify({ owner: retained.owner, values, initial, record, character, call, conflict }) : null;
    if (stored !== retained.stored) {
      if (stored === null) sessionStorage.removeItem(prefix + key);
      else sessionStorage.setItem(prefix + key, stored);
      retained.stored = stored;
    }
  } catch { /* Disabled or full storage leaves the in-memory draft usable. */ }
  updateWarning();
}

function warn(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = '';
}

export function updateWarning() {
  if ([...drafts].some(([key, retained]) => dirty(retained.draft) && ownsDraft(key, retained.draft))) window.addEventListener('beforeunload', warn);
  else window.removeEventListener('beforeunload', warn);
}

export function getDraft(key: string, values: Values, record?: Diary, character?: Character): Draft {
  const retained = drafts.get(key);
  if (retained && dirty(retained.draft) && ownsDraft(key, retained.draft)) return retained.draft;
  retained?.stop();
  let stored: string | null = null;
  let restored: Partial<Draft> = {};
  try {
    stored = sessionStorage.getItem(prefix + key);
    const data: unknown = JSON.parse(stored ?? 'null');
    if (restorable(data, record)) {
      restored = { values: data.values, initial: data.initial, record: data.record, character: data.character,
        call: data.call, conflict: Boolean(data.conflict), uncertain: Boolean(data.call),
        error: data.call ? '上次保存的结果尚未确认。请重试同一次保存以找回结果。' : '' };
    }
  } catch { /* Unreadable storage must not prevent opening the editor. */ }
  const draft = reactive<Draft>({ values: copy(values), initial: copy(values), record, character,
    busy: false, uncertain: false, conflict: false, error: '', ...restored });
  const scope = effectScope(true);
  const entry = { draft, stored, owner: crypto.randomUUID(), stop: () => scope.stop() };
  drafts.set(key, entry);
  // Keep watching off-route so a request finishing after unmount updates storage too.
  scope.run(() => watch(draft, () => persist(key, entry), { deep: true, flush: 'sync' }));
  persist(key, entry);
  return draft;
}

export function forgetDraft(key: string, draft: Draft): boolean {
  if (!ownsDraft(key, draft)) return false;
  drafts.get(key)!.stop();
  drafts.delete(key);
  try { sessionStorage.removeItem(prefix + key); } catch { /* The memory copy is still cleared. */ }
  updateWarning();
  return true;
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
