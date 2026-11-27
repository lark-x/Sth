import { onScopeDispose, reactive, ref, shallowRef } from 'vue';
import { operation } from '../api.ts';
import { ApiError, message, recover, write } from './api.ts';
import type { OperationCall } from './api.ts';

export function stored<T>(key: string): T | undefined {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? undefined; } catch { return; }
}
export function retain(key: string, value?: unknown) {
  try {
    if (value === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* The editor also works when session storage is unavailable. */ }
}

export function useRead<T>(loader: (signal: AbortSignal) => Promise<T>) {
  const data = shallowRef<T>();
  const busy = ref(true);
  const error = ref('');
  let controller: AbortController | undefined;
  async function reload() {
    controller?.abort();
    const active = controller = new AbortController();
    busy.value = true;
    error.value = '';
    try {
      const result = await loader(active.signal);
      if (!active.signal.aborted) data.value = result;
    } catch (reason) { if (!active.signal.aborted) error.value = message(reason); }
    finally { if (!active.signal.aborted) busy.value = false; }
  }
  onScopeDispose(() => controller?.abort());
  void reload();
  return { data, busy, error, reload };
}

export function useMutation<T>(key: string, id: string, identity: string, complete: (result: T) => void) {
  const previous = stored<OperationCall>(key);
  const pending = previous?.operationId === id && typeof previous.stepId === 'string' && previous.input ? previous : undefined;
  const state = reactive({ busy: false, pending, conflict: false,
    error: pending ? '上次保存的结果尚未确认。请重试同一次提交以找回保存结果。' : '' });
  let disposed = false;
  onScopeDispose(() => { disposed = true; });
  async function submit(input: Record<string, unknown>) {
    if (state.busy || state.conflict) return;
    const retry = Boolean(state.pending);
    const call = state.pending ?? operation(id, input);
    state.pending = call;
    retain(key, call);
    state.busy = true;
    state.error = '';
    try {
      const result = await (retry ? recover<T>(call) : write<T>(call));
      if (typeof (result as Record<string, unknown>)[identity] !== 'string') throw new ApiError(502, 'invalid_result', '保存结果无法读取。');
      if (disposed) return;
      state.pending = undefined;
      retain(key);
      complete(result);
    } catch (error) {
      if (disposed) return;
      const uncertain = !(error instanceof ApiError) || error.status === 0 || error.status === 408 || error.status >= 500;
      state.error = uncertain ? '保存结果尚未确认。请重试同一次提交，找回保存结果。' : message(error);
      state.conflict = error instanceof ApiError && error.status === 409;
      if (!uncertain) { state.pending = undefined; retain(key); }
    } finally { if (!disposed) state.busy = false; }
  }
  return { state, submit };
}
