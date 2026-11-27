import { ref, watch } from 'vue';
import type { OperationCall } from './api.ts';

const key = 'sth:quick-note:v1';
function restore(): { body: string; call?: OperationCall } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (typeof saved?.body !== 'string') return { body: '' };
    const call = saved.call;
    if (call?.operationId === 'diary.create' && typeof call.stepId === 'string' &&
      call.input?.body === saved.body && typeof call.input.title === 'string' && typeof call.input.diaryDate === 'string') {
      return { body: saved.body, call };
    }
    return { body: saved.body };
  } catch { return { body: '' }; }
}

const restored = restore();
export const quickBody = ref(restored.body);
export const quickCall = ref<OperationCall | undefined>(restored.call);

watch([quickBody, quickCall], ([body, call]) => {
  try {
    if (body || call) sessionStorage.setItem(key, JSON.stringify({ body, call }));
    else sessionStorage.removeItem(key);
  } catch { /* The current tab still keeps the draft when storage is unavailable. */ }
}, { flush: 'sync' });
