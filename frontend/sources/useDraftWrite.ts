import { computed, onBeforeUnmount, watch } from 'vue';
import { ApiError, errorText, invoke, retryWrite } from './api';
import type { Call } from './api';
import { copy, forgetDraft, persistDraft } from './drafts';
import type { Draft } from './drafts';

// Keep the original call until its outcome is known, including across route
// unmounts. Navigation cancels reads, but must not cancel an in-flight write.
export function useDraftWrite<T>(key: string, draft: Draft<T>,
  navigate: (href: string) => void, onConflict?: () => Promise<void>) {
  let active = true;
  const locked = computed(() => draft.busy || Boolean(draft.call) || Boolean(draft.saved));
  watch(draft, () => persistDraft(key, draft), { deep: true, flush: 'sync' });
  onBeforeUnmount(() => { active = false; });
  async function save<R>(makeCall: () => Call, destination: (result: R) => string) {
    if (draft.busy || draft.saved || draft.conflict) return;
    const retry = Boolean(draft.call);
    draft.error = '';
    draft.call ??= makeCall();
    draft.busy = true;
    persistDraft(key, draft);
    try {
      const result = retry ? await retryWrite<R>(copy(draft.call)) : await invoke<R>(copy(draft.call));
      draft.saved = destination(result);
      draft.initial = copy(draft.values);
      draft.call = undefined;
      draft.busy = false;
      persistDraft(key, draft);
      if (active) { forgetDraft(key); navigate(draft.saved); }
    } catch (reason) {
      draft.error = errorText(reason);
      if (reason instanceof ApiError && reason.conflict && onConflict) {
        draft.call = undefined;
        draft.conflict = true;
        if (active) await onConflict();
      } else if (!(reason instanceof ApiError) || !reason.uncertain) draft.call = undefined;
      if (draft.call) draft.error += ' 请重试同一次提交以确认保存结果。';
    } finally {
      draft.busy = false;
      persistDraft(key, draft);
    }
  }
  return { locked, save };
}
