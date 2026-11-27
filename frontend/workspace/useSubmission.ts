import { onScopeDispose, ref, shallowRef } from 'vue';
import { invoke, operation } from '../api.ts';
import type { OperationCall } from '../api.ts';
import { ApiError, message, recover } from './api.ts';

export function savedText(key: string): string {
  try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; }
}
export function retain(key: string, value: string) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch { /* Editing remains available when browser storage is unavailable. */ }
}

export function useSubmission<T>(key: string, operationId: string, validate: (value: T) => boolean, saved: (value: T) => void) {
  const pending = shallowRef<OperationCall>();
  const busy = ref(false);
  const error = ref('');
  let disposed = false;
  onScopeDispose(() => { disposed = true; });
  try {
    const call = JSON.parse(savedText(key) || 'null') as OperationCall | null;
    if (call?.operationId === operationId && typeof call.stepId === 'string' && call.input && typeof call.input === 'object') {
      pending.value = call;
      error.value = '上次提交的结果尚未确认。请重试同一次提交以找回已保存内容。';
    }
  } catch { retain(key, ''); }

  async function submit(input: Record<string, unknown>) {
    if (busy.value) return;
    const retry = Boolean(pending.value);
    const call = pending.value ?? operation(operationId, input);
    pending.value = call;
    retain(key, JSON.stringify(call));
    busy.value = true;
    error.value = '';
    try {
      const result = await (retry ? recover<T>(call) : invoke<T>(call));
      if (!validate(result)) throw new ApiError(502, 'invalid_result', '保存结果无法读取，请重试同一次提交。');
      if (disposed) return;
      pending.value = undefined;
      retain(key, '');
      saved(result);
    } catch (reason) {
      if (disposed) return;
      const uncertain = !(reason instanceof ApiError) || reason.status === 0 || reason.status === 408 || reason.status >= 500;
      error.value = uncertain ? '保存结果尚未确认。请重试同一次提交，找回保存结果。' : message(reason);
      if (!uncertain) {
        pending.value = undefined;
        retain(key, '');
      }
    } finally { if (!disposed) busy.value = false; }
  }
  return { pending, busy, error, submit };
}
