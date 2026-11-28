<script setup lang="ts">
import type { Component } from 'vue';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronDown,
  Clock,
  Ellipsis,
  File,
  FileText,
  Folder,
  House,
  Library,
  ListChecks,
  Map,
  NotebookPen,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Users,
  X,
} from '@lucide/vue';

defineProps<{ name: string }>();

const icons: Record<string, Component> = {
  panels: PanelLeft,
  library: Library,
  diary: NotebookPen,
  pen: Pencil,
  people: Users,
  book: BookOpen,
  tasks: ListChecks,
  settings: Settings,
  arrow: ArrowRight,
  next: ArrowRight,
  back: ArrowLeft,
  plus: Plus,
  refresh: RefreshCw,
  home: House,
  clock: Clock,
  search: Search,
  'chevron-down': ChevronDown,
  close: X,
  file: File,
  'file-text': FileText,
  folder: Folder,
  map: Map,
  save: Save,
  ellipsis: Ellipsis,
};
</script>

<template>
  <component
    :is="icons[name] ?? icons.arrow"
    class="icon"
    :size="20"
    :stroke-width="1.65"
    aria-hidden="true"
    focusable="false"
  />
</template>
