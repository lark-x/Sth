import { ApiError, entity, invoke, retryWrite, revision, step } from './api.js';
import { workspaceError } from './workspace-actions.js';
import { button, esc, link, path } from './ui.js';

export function bindScenePlacement(ctx, { key, form, view = form, start, scene, chapterId, readChapter, complete, backTo }) {
  const storageKey = `sth:scene-placement:${key}`;
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(storageKey)) ?? {}; } catch { }
  let reviewedChapter;
  let busy = false;
  let error = '';
  const active = () => ctx.active() && location.href === ctx.url.href;
  const currentScene = () => saved.scene ?? scene;
  const targetChapter = () => saved.chapterId ?? chapterId;

  function persist(changes) {
    const next = { ...saved, ...changes };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      throw new ApiError(400, 'placement_storage_unavailable', '无法记录提交进度。请恢复浏览器的本地存储后重试。');
    }
    saved = next;
  }

  const panel = document.createElement('section');
  panel.setAttribute('aria-label', '场景创建进度');
  view.after(panel);
  const notice = form.querySelector('[role="alert"]');

  function render(focus = false) {
    const current = currentScene();
    const continuing = Boolean(saved.call || saved.scene || saved.chapterId);
    const review = saved.review && !reviewedChapter;
    const message = error || (saved.call && !busy ? '上次提交的结果待确认。' : '');
    view.hidden = continuing;
    form.querySelectorAll('button[type="submit"]').forEach(control => { control.disabled = busy; });
    notice.hidden = continuing || !error;
    notice.textContent = notice.hidden ? '' : error;
    panel.hidden = !continuing;
    panel.innerHTML = continuing ? `
      <p role="status">${busy ? '正在保存并核对章节…' : current ? `场景「${esc(current.title)}」已保存。` : ''}</p>
      ${message ? `<p class="notice" role="alert" tabindex="-1">${esc(message)}</p>` : ''}
      ${reviewedChapter ? `<h2>${esc(reviewedChapter.title)} · 当前章序</h2>
        ${reviewedChapter.scenes.length ? `<ol>${reviewedChapter.scenes.map(item => `<li>${esc(item.title)}</li>`).join('')}</ol>` : '<p>本章尚无场景。</p>'}` : ''}
      <div class="actions">
        ${busy ? '' : button('placement-continue', saved.call ? '重试同一次提交' : review ? '重新读取最新章节' : '归入本章并开始写作', null, 'primary')}
        ${current ? link(path('scenes', current.sceneId), '查看已保存场景', null, 'quiet') : ''}
        ${link(backTo, '返回', null, 'quiet')}
      </div>` : '';
    const next = panel.querySelector('#placement-continue');
    if (next) next.onclick = () => review && !saved.call ? void reviewOrder() : void run();
    if (focus) (panel.querySelector('[role="alert"]') ?? next ?? (notice.hidden ? null : notice))?.focus();
  }

  async function write(call, recover = false) {
    if (!recover) persist({ call });
    return recover ? retryWrite(call) : invoke(call);
  }

  async function append() {
    const chapter = reviewedChapter ?? await readChapter(targetChapter());
    if (!active()) return;
    const sceneIds = chapter.scenes.map(item => item.sceneId);
    const { sceneId } = currentScene();
    if (sceneIds.includes(sceneId)) return;
    await write(step('chapter.arrange', {
      chapterId: chapter.chapterId, expectedRevision: chapter.revision, sceneIds: [...sceneIds, sceneId],
    }));
  }

  async function run(event) {
    if (busy || !active()) return;
    busy = true;
    error = '';
    try {
      const pending = saved.call;
      const call = pending ?? (event ? start(event) : undefined);
      if (call) {
        const { operationId } = call;
        const resultPromise = write(call, Boolean(pending));
        render();
        const result = await resultPromise;
        if (!active()) return;
        if (operationId === 'scene.create') {
          const { sceneId, title } = entity(result, 'sceneId');
          persist({ scene: { sceneId, title, revision: revision(result) }, call: undefined });
        } else if (operationId === 'chapter.create') {
          persist({ chapterId: entity(result, 'chapterId').chapterId, call: undefined });
        }
      } else if (event?.submitter?.value) {
        persist({ chapterId: event.submitter.value });
      } else if (event) return;
      if (targetChapter() && call?.operationId !== 'chapter.arrange') {
        render();
        await append();
      }
      if (!active()) return;
      sessionStorage.removeItem(storageKey);
      complete(currentScene(), targetChapter());
    } catch (reason) {
      if (!active()) return;
      const conflict = reason.code === 'chapter_revision_conflict';
      error = conflict ? '章节顺序已有更新。请读取当前章序后再归入。' : workspaceError(reason);
      if (reason instanceof ApiError && !reason.uncertain && reason.code !== 'placement_storage_unavailable' &&
        ![401, 403, 429].includes(reason.status)) {
        try { persist({ call: undefined, review: conflict || saved.review }); } catch { }
      }
      reviewedChapter = undefined;
    } finally {
      busy = false;
      if (active()) render(Boolean(error));
    }
  }

  async function reviewOrder() {
    if (busy || !active()) return;
    busy = true;
    error = '';
    render();
    try {
      reviewedChapter = await readChapter(targetChapter());
    } catch (reason) {
      error = workspaceError(reason);
    } finally {
      busy = false;
      if (active()) render(true);
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    void run(event);
  }, { capture: true });
  render();
}
