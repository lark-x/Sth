import type { InjectionKey, Ref } from 'vue';

export interface ManuscriptView {
  focus: Ref<boolean>;
  library: Ref<boolean>;
  toggleFocus: () => void;
  toggleLibrary: () => void;
  showSheets: () => void;
}
export const manuscriptView: InjectionKey<ManuscriptView> = Symbol('manuscript-view');
