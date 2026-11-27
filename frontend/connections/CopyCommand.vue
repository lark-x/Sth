<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue';

const props = withDefaults(defineProps<{
  text: string;
  label?: string;
  successMessage?: string;
  fallbackMessage?: string;
  validUntil?: number;
}>(), {
  label: '复制安装命令', successMessage: '安装命令已复制。', fallbackMessage: '已选中安装命令，请手动复制。',
});
const emit = defineEmits<{ expired: [] }>();
const targetId = useId();
const target = ref<HTMLElement>();
const status = ref('');
const nativeCommands = typeof window !== 'undefined' && 'CommandEvent' in window;
let mounted = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastMessage = '';

function clearStatus() { clearTimeout(timer); status.value = ''; }
watch(() => props.text, clearStatus);
onBeforeUnmount(() => { mounted = false; clearStatus(); });

async function copy() {
  if (props.validUntil !== undefined && Date.now() >= props.validUntil) { emit('expired'); return; }
  const text = props.text;
  let message = props.successMessage;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    if (!mounted || props.text !== text || !target.value) return;
    window.getSelection()?.selectAllChildren(target.value);
    message = props.fallbackMessage;
  }
  if (!mounted || props.text !== text) return;
  if (props.validUntil !== undefined && Date.now() >= props.validUntil) { emit('expired'); return; }
  clearStatus();
  if (lastMessage === message) message += '\u00a0';
  lastMessage = message;
  status.value = message;
  timer = setTimeout(clearStatus, 4200);
}

function onCommand(event: Event) {
  if ((event as Event & { command?: string }).command === '--copy') void copy();
}

function onClick() { if (!nativeCommands) void copy(); }
</script>

<template>
  <div class="command-copy">
    <pre :id="targetId" ref="target" @command="onCommand"><code>{{ text }}</code></pre>
    <div class="copy-actions">
      <button type="button" class="button secondary" command="--copy" :commandfor="targetId" @click="onClick">{{ label }}</button>
      <slot />
    </div>
    <p class="copy-status" role="status" aria-atomic="true">{{ status }}</p>
  </div>
</template>

<style scoped>
.command-copy { min-inline-size: 0; }
pre { margin: .65rem 0; padding: .9rem 1rem; border-radius: 6px; background: var(--sidebar); color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; font: .85rem/1.8 ui-monospace, Consolas, monospace; user-select: text; }
.copy-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.button { min-inline-size: 2.75rem; min-block-size: 2.75rem; }
.copy-status { min-block-size: 1.6em; margin-block-start: .35rem; color: var(--muted); font-size: .88rem; }
</style>
