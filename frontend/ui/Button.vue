<script setup lang="ts">
import { Primitive } from 'reka-ui';
import type { PrimitiveProps } from 'reka-ui';
import './ui.css';

// shadcn-vue's source-owned Button composition, styled with Sth's shared tokens.
withDefaults(defineProps<PrimitiveProps & {
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  size?: 'default' | 'sm' | 'icon';
}>(), { as: 'button', variant: 'default', size: 'default' });
</script>

<template>
  <Primitive :as="as" :as-child="asChild" :type="as === 'button' && !asChild ? 'button' : undefined"
    class="ui-button" data-slot="button" :data-variant="variant" :data-size="size"><slot /></Primitive>
</template>
