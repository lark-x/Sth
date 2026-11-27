import { reactive } from 'vue';
import type { Call, Source, SourceKind } from './api';

export interface SourceValues { kind: SourceKind; title: string; body: string; origin: string; projectIds: string[] }
export interface AdoptionValues { characterId: string; label: string; text: string }
export interface Draft<T> {
  values: T;
  initial: T;
  base?: Source;
  call?: Call;
  saved?: string;
  busy: boolean;
  conflict: boolean;
  error: string;
}
const drafts = new Map<string, unknown>();
const prefix = 'sth:sources:draft:v1:';
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const dirty = <T>(draft: Draft<T>): boolean => draft.busy || Boolean(draft.call) || !same(draft.values, draft.initial);
export const valuesFor = (source: Source): SourceValues => ({ kind: source.kind, title: source.title,
  body: source.body, origin: source.origin ?? '', projectIds: [...source.projectIds] });

function matches(value: unknown, sample: unknown): boolean {
  if (Array.isArray(sample)) return Array.isArray(value) && value.every(item => typeof item === 'string');
  if (sample && typeof sample === 'object') return Boolean(value && typeof value === 'object' &&
    Object.entries(sample).every(([key, item]) => matches((value as Record<string, unknown>)[key], item)));
  return typeof value === typeof sample;
}
export function getDraft<T>(key: string, values: T, base?: Source): Draft<T> {
  const retained = drafts.get(key) as Draft<T> | undefined;
  if (retained && (dirty(retained) || retained.saved)) return retained;
  let restored: Partial<Draft<T>> = {};
  try {
    const data = JSON.parse(sessionStorage.getItem(prefix + key) ?? 'null');
    if (data && matches(data.values, values) && matches(data.initial, values) &&
      (!data.base || (base && data.base.sourceId === base.sourceId &&
        Number.isSafeInteger(data.base.revision) && data.base.revision > 0 &&
        matches(data.base, { sourceId: '', revision: 1, kind: '', title: '', body: '', href: '', projectIds: [] }))) &&
      (!data.call || (['source.create', 'source.revise', 'character.adopt-entries'].includes(data.call.operationId) &&
        typeof data.call.stepId === 'string' && data.call.input && typeof data.call.input === 'object')) &&
      (!data.saved || typeof data.saved === 'string')) {
      restored = { values: data.values, initial: data.initial, base: data.base,
        call: data.call, saved: data.saved, conflict: Boolean(data.conflict), error: '' };
    }
  } catch { /* A disabled or full session store must not prevent editing. */ }
  const draft = reactive({ values: copy(values), initial: copy(values), base,
    busy: false, conflict: false, error: '', ...restored }) as Draft<T>;
  drafts.set(key, draft);
  persistDraft(key, draft);
  return draft;
}
function warn(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
export function persistDraft<T>(key: string, draft: Draft<T>) {
  try {
    if (dirty(draft) || draft.saved) sessionStorage.setItem(prefix + key, JSON.stringify(draft));
    else sessionStorage.removeItem(prefix + key);
  } catch { /* In-memory drafts remain available if browser storage is unavailable. */ }
  const unsaved = [...drafts.values()].some(item => dirty(item as Draft<unknown>));
  if (unsaved) window.addEventListener('beforeunload', warn);
  else window.removeEventListener('beforeunload', warn);
}
export function forgetDraft(key: string) {
  drafts.delete(key);
  try { sessionStorage.removeItem(prefix + key); } catch { /* Storage may be disabled. */ }
  if (![...drafts.values()].some(item => dirty(item as Draft<unknown>))) window.removeEventListener('beforeunload', warn);
}
