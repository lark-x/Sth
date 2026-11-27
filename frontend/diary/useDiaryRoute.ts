import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ApiError, catalog, errorText, invoke, listAll, read, retryWrite, revision, step } from './api';
import type { Backlink, Character, Diary, Operation, Project, Source, SourcePin } from './api';
import { copy, dirty, forgetDraft, getDraft, indexHref, ownsDraft, resourceHref, same, today, updateWarning, valuesFor } from './drafts';
import type { Draft } from './drafts';

type Emit = { (event: 'navigate', href: string): void; (event: 'refresh'): void };

export function useDiaryRoute(props: { url: URL }, emit: Emit) {
  const loading = ref(true);
  const pageError = ref('');
  const contextError = ref('');
  const sourceError = ref('');
  const record = ref<Diary>();
  const draft = ref<Draft>();
  const projects = ref<Project[]>([]);
  const characters = ref<Character[]>([]);
  const sources = ref<Source[]>([]);
  const backlinks = ref<Backlink[]>([]);
  const operations = ref(new Map<string, Operation>());
  const latest = ref<Diary | Character>();
  const latestError = ref('');
  const latestLoading = ref(false);
  const form = ref<HTMLFormElement>();
  const saveButton = ref<HTMLButtonElement>();
  const heading = ref<HTMLHeadingElement>();
  const isNew = ref(false);
  const isEditing = ref(false);
  const pinned = ref<number>();
  const cancelHref = ref('/');
  let controller: AbortController | undefined;
  let alive = true;
  let characterRequest = 0;
  let latestRequest = 0;
  let generation = 0;
  const routeKey = computed(() => props.url.pathname + props.url.search);
  const title = computed(() => isEditing.value ? isNew.value ? '写日记' : '编辑日记' : record.value?.title ?? '日记');
  const locked = computed(() => Boolean(draft.value?.busy || draft.value?.uncertain));
  const changed = computed(() => draft.value ? dirty(draft.value) : false);
  const properties = computed(() => operations.value.get(isNew.value ? 'diary.create' : 'diary.revise')?.inputSchema.properties);
  const canCite = computed(() => Boolean(properties.value?.sourcePins));
  const projectName = computed(() => {
    const projectId = draft.value?.values.projectId ?? record.value?.projectId;
    return projectId ? projects.value.find(project => project.projectId === projectId)?.title ?? '项目日记' : '不归入项目';
  });
  const narrator = computed(() => {
    const characterId = draft.value?.values.characterId;
    const pinnedCharacter = draft.value?.record?.character ?? record.value?.character;
    return characterId ? draft.value?.character?.name ?? (pinnedCharacter?.characterId === characterId ? pinnedCharacter.name : undefined)
      ?? characters.value.find(character => character.characterId === characterId)?.name ?? '角色日记'
      : record.value?.character?.name ?? '个人日记';
  });
  const characterOptions = computed(() => characters.value.filter(character =>
    !character.projectId || character.projectId === draft.value?.values.projectId));

  function navigate(event: MouseEvent, href: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    emit('navigate', href);
  }

  async function readDiary(noteId: string, signal?: AbortSignal, pinnedRevision?: number) {
    const diary = await read<Diary>('diary.read', { noteId, ...(pinnedRevision ? { revision: pinnedRevision } : {}) }, signal);
    if (diary.noteId !== noteId) throw new ApiError(502, '', '服务未返回正确的日记。');
    revision(diary);
    return diary;
  }

  async function initialPin(params: URLSearchParams, signal: AbortSignal): Promise<SourcePin | undefined> {
    const sourceId = params.get('sourceId');
    const sourceRevision = Number(params.get('sourceRevision'));
    const positions = ['start', 'end'].map(key => params.get(key));
    if (!sourceId || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || positions.some(value => !/^\d+$/.test(value ?? ''))) return;
    const [start, end] = positions.map(Number) as [number, number];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return;
    const source = await read<Source>('source.read', { sourceId, revision: sourceRevision,
      range: { start, end }, contextChars: 0 }, signal);
    if (typeof source.body !== 'string') throw new ApiError(502, '', '服务未返回引用原文。');
    return { sourceId, revision: sourceRevision, range: { start, end }, excerpt: source.body };
  }

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const current = ++generation;
    const url = new URL(props.url.href);
    const key = routeKey.value;
    loading.value = true;
    pageError.value = contextError.value = sourceError.value = '';
    latest.value = undefined;
    latestError.value = '';
    latestLoading.value = false;
    latestRequest++;
    draft.value = undefined;
    record.value = undefined;
    projects.value = [];
    characters.value = [];
    sources.value = [];
    backlinks.value = [];
    try {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 2 || parts[0] !== 'diaries') throw new ApiError(404);
      let noteId: string;
      try { noteId = decodeURIComponent(parts[1]!); } catch { throw new ApiError(404); }
      isNew.value = noteId === 'new';
      const requested = url.searchParams.get('revision');
      pinned.value = !isNew.value && requested !== null ? Number(requested) : undefined;
      if (!isNew.value && requested !== null && (!/^[1-9]\d*$/.test(requested) || !Number.isSafeInteger(pinned.value))) {
        throw new ApiError(400, 'invalid_revision');
      }
      isEditing.value = isNew.value || (!pinned.value && url.searchParams.get('edit') === '1');
      const [available, diary] = await Promise.all([catalog(signal),
        isNew.value ? undefined : readDiary(noteId, signal, pinned.value)]);
      if (signal.aborted) return;
      operations.value = available;
      record.value = diary;
      const characterId = isNew.value ? url.searchParams.get('characterId') : null;
      const [allProjects, allCharacters, character, pin] = await Promise.all([
        listAll<Project>(available, 'project.list', {}, signal).catch(error => {
          if (!signal.aborted) contextError.value = `作品列表读取失败。${errorText(error)}`;
          return [];
        }),
        isNew.value ? listAll<Character>(available, 'character.list', {}, signal).catch(error => {
          if (!signal.aborted) contextError.value = `叙述者列表读取失败。${errorText(error)}`;
          return [];
        }) : [],
        characterId ? read<Character>('character.read', { characterId }, signal) : undefined,
        isNew.value && canCite.value ? initialPin(url.searchParams, signal) : undefined,
      ]);
      if (signal.aborted) return;
      projects.value = allProjects;
      characters.value = allCharacters;
      if (character && !allCharacters.some(item => item.characterId === character.characterId)) characters.value.push(character);
      const projectId = character?.projectId ?? url.searchParams.get('projectId') ?? '';
      cancelHref.value = diary ? resourceHref('diaries', diary.noteId)
        : character ? resourceHref('characters', character.characterId) : indexHref(projectId);
      if (isEditing.value) {
        draft.value = getDraft(key, diary ? valuesFor(diary) : { title: '', body: '', diaryDate: today(),
          projectId, characterId: character?.characterId ?? '', sourcePins: pin ? [pin] : [] }, diary, character);
      }
      document.title = `${title.value} · Sth`;
      loading.value = false;
      await nextTick();
      if (!signal.aborted) heading.value?.focus({ preventScroll: true });
      // Auxiliary references must not prevent the author from reaching the body.
      await Promise.all([
        isEditing.value && canCite.value && available.has('source.list')
          ? listAll<Source>(available, 'source.list', {}, signal).then(items => { if (!signal.aborted) sources.value = items; })
            .catch(error => { if (!signal.aborted) sourceError.value = errorText(error); }) : undefined,
        !isEditing.value && diary && available.has('character.backlinks')
          ? listAll<Backlink>(available, 'character.backlinks', { kind: 'diary', id: diary.noteId, revision: diary.revision }, signal)
            .then(items => { if (!signal.aborted) backlinks.value = items; })
            .catch(error => { if (!signal.aborted) contextError.value = `角色证据读取失败。${errorText(error)}`; }) : undefined,
      ]);
    } catch (error) {
      if (!signal.aborted) pageError.value = errorText(error);
    } finally {
      if (current === generation && !signal.aborted) loading.value = false;
    }
  }

  async function selectCharacter() {
    const current = draft.value;
    if (!current || locked.value) return;
    const selected = current.values.characterId;
    const request = ++characterRequest;
    current.character = undefined;
    current.conflict = false;
    latest.value = undefined;
    latestLoading.value = false;
    latestError.value = '';
    latestRequest++;
    contextError.value = '';
    if (!selected) return;
    try {
      const character = await read<Character>('character.read', { characterId: selected }, controller?.signal);
      if (request === characterRequest && current === draft.value && selected === current.values.characterId) current.character = character;
    } catch (error) {
      if (alive && request === characterRequest && current === draft.value && !controller?.signal.aborted) contextError.value = errorText(error);
    }
  }

  function selectProject() {
    if (!draft.value || locked.value) return;
    draft.value.values.characterId = '';
    void selectCharacter();
  }

  async function showLatest() {
    const current = draft.value;
    if (!current?.conflict) return;
    const token = ++latestRequest;
    const selected = current.values.characterId;
    latestLoading.value = true;
    latestError.value = '';
    latest.value = undefined;
    try {
      const result = current.record ? await readDiary(current.record.noteId, controller?.signal)
        : await read<Character>('character.read', { characterId: selected }, controller?.signal);
      revision(result);
      if (token === latestRequest && current === draft.value && selected === current.values.characterId) latest.value = result;
    } catch (error) {
      if (token === latestRequest && current === draft.value && !controller?.signal.aborted) latestError.value = errorText(error);
    } finally {
      if (token === latestRequest) latestLoading.value = false;
    }
  }

  function applyLatest(replace: boolean) {
    const current = draft.value;
    const result = latest.value;
    if (!current || !result || locked.value) return;
    if ('noteId' in result) {
      const values = valuesFor(result);
      if (!replace) {
        for (const field of ['title', 'body', 'diaryDate', 'sourcePins'] as const) {
          if (!same(current.values[field], current.initial[field])) Object.assign(values, { [field]: copy(current.values[field]) });
        }
      }
      current.initial = valuesFor(result);
      current.values = values;
      current.record = result;
      record.value = result;
    } else {
      if (result.characterId !== current.values.characterId) return;
      current.character = result;
    }
    current.conflict = false;
    current.error = '';
    latest.value = undefined;
    void nextTick(() => saveButton.value?.focus());
  }

  async function inputFor(current: Draft): Promise<Record<string, unknown>> {
    const { title, body, diaryDate, projectId, characterId, sourcePins } = copy(current.values);
    const input: Record<string, unknown> = { title: title.trim(), body, diaryDate };
    if (canCite.value && (sourcePins.length || current.record?.sourcePins?.length)) input.sourcePins = sourcePins;
    if (current.record) return { ...input, noteId: current.record.noteId, expectedRevision: revision(current.record) };
    if (projectId) input.projectId = projectId;
    if (characterId) {
      const character = current.character ?? await read<Character>('character.read', { characterId });
      if (character.characterId !== characterId || (character.projectId && character.projectId !== projectId)) throw new ApiError(409, 'character_project_mismatch');
      current.character = character;
      input.characterId = characterId;
      input.expectedCharacterRevision = revision(character);
    }
    return input;
  }

  function validate(current: Draft): boolean {
    if (!form.value?.reportValidity()) return false;
    for (const name of ['title', 'body'] as const) {
      if (!current.values[name].trim()) {
        const field = form.value.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;
        field?.setCustomValidity('请输入内容，不能只填写空格。');
        field?.reportValidity();
        return false;
      }
    }
    const date = current.values.diaryDate;
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000') || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) {
      current.error = '请输入有效的日记日期。';
      return false;
    }
    return true;
  }

  async function save() {
    const current = draft.value;
    if (!current || current.busy || current.conflict || !ownsDraft(routeKey.value, current)) return;
    if (!current.uncertain && !validate(current)) return;
    const key = routeKey.value;
    const operationId = current.record ? 'diary.revise' : 'diary.create';
    current.busy = true;
    current.error = '';
    updateWarning();
    try {
      const retry = Boolean(current.call);
      if (!current.call) {
        const input = await inputFor(current);
        if (!ownsDraft(key, current)) return;
        current.call = step(operationId, input);
      }
      const saved = await (retry ? retryWrite<Diary>(current.call) : invoke<Diary>(current.call));
      if (!saved.noteId) throw new ApiError(502, '', '服务未返回日记编号。');
      revision(saved);
      if (forgetDraft(key, current)) current.saved = saved;
    } catch (error) {
      current.uncertain = Boolean(current.call && (!(error instanceof ApiError) || error.uncertain));
      if (!current.uncertain) current.call = undefined;
      current.conflict = Boolean(error instanceof ApiError && error.conflict && (current.record || current.character));
      current.error = current.conflict ? '' : `${errorText(error)}${current.uncertain ? ' 请重试同一次保存。' : ''}`;
    } finally {
      current.busy = false;
      updateWarning();
    }
    if (alive && current === draft.value) {
      if (current.error) await nextTick(() => saveButton.value?.focus());
    }
  }

  function clearValidity(event: Event) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      target.setCustomValidity('');
      target.removeAttribute('aria-invalid');
    }
  }

  function invalid(event: Event) {
    const target = event.target as HTMLInputElement;
    target.setAttribute('aria-invalid', 'true');
    if (target.validity.valueMissing) target.setCustomValidity(`请填写${target.labels?.[0]?.textContent?.replace(/\s*\*$/, '') ?? '必填内容'}。`);
  }

  function discard() {
    if (locked.value || !window.confirm('清除这份未保存的草稿？')) return;
    if (!draft.value || !forgetDraft(routeKey.value, draft.value)) return;
    void load();
    emit('refresh');
  }

  watch(() => draft.value?.values, () => {
    if (draft.value && !draft.value.conflict && !draft.value.uncertain) draft.value.error = '';
    updateWarning();
  }, { deep: true, flush: 'sync' });
  watch(() => draft.value?.saved, saved => {
    if (!saved || !alive) return;
    emit('navigate', resourceHref('diaries', saved.noteId));
    emit('refresh');
  });
  watch(() => draft.value?.conflict, conflict => {
    if (conflict && !latestLoading.value && !latest.value) void showLatest();
  });
  watch(() => props.url.href, () => void load(), { immediate: true });
  onBeforeUnmount(() => { alive = false; controller?.abort(); generation++; latestRequest++; characterRequest++; });

  return { loading, pageError, contextError, sourceError, record, draft, projects, sources, backlinks,
    latest, latestError, latestLoading, form, saveButton, heading, isNew, isEditing, pinned, cancelHref,
    title, locked, changed, properties, canCite, projectName, narrator, characterOptions,
    load, navigate, selectCharacter, selectProject, showLatest, applyLatest, save, discard, clearValidity, invalid };
}
