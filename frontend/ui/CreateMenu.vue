<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue';
import { DropdownMenuRoot, DropdownMenuTrigger, DropdownMenuPortal, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from 'reka-ui';
import AppIcon from '../AppIcon.vue';
import Button from './Button.vue';
const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const open = ref(false);
const menuId = useId();
const options = [
  { href: '/diaries/new', icon: 'diary', label: '写日记' },
  { href: '/scenes/new', icon: 'pen', label: '新建场景' },
  { href: '/projects/new', icon: 'book', label: '新建作品' },
];
watch(() => props.url.href, () => { open.value = false; });
watch(open, async visible => {
  if (!visible) return;
  await nextTick();
  if (!open.value) return;
  const menu = document.getElementById(menuId);
  // A reopen can cancel Reka's exit before the content unmounts. In that case
  // its mount autofocus does not run again. Re-enter only from this trigger;
  // never steal focus from a different control or an already focused menu item.
  const triggerId = menu?.getAttribute('aria-labelledby');
  if (menu && triggerId && document.activeElement?.id === triggerId) menu.focus({ preventScroll: true });
});
function follow(event: MouseEvent, href: string) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  open.value = false;
  emit('navigate', href);
}
</script>

<template>
  <DropdownMenuRoot v-model:open="open" :modal="false">
    <DropdownMenuTrigger as-child>
      <Button class="library-create" variant="outline" size="sm"><AppIcon name="plus" />新建<AppIcon name="chevron-down" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent :id="menuId" class="ui-menu" align="start" :side-offset="6" :collision-padding="12" aria-label="新建内容">
        <DropdownMenuItem v-for="option in options" :key="option.href" as-child class="ui-menu-item">
          <a :href="option.href" @click="follow($event, option.href)"><AppIcon :name="option.icon" />{{ option.label }}</a>
        </DropdownMenuItem>
        <DropdownMenuSeparator class="ui-menu-separator" />
        <DropdownMenuItem as-child class="ui-menu-item">
          <a href="/workspace?tab=continue" @click="follow($event, '/workspace?tab=continue')"><AppIcon name="arrow" />继续写作</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
