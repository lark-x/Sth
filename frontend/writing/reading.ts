import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import type { Ref } from 'vue';

export interface PassageRange {
  start: number;
  end: number;
}
interface ReadingPosition {
  offset: number;
  top: number;
}

export function passageRange(
  params: URLSearchParams,
  length: number,
): PassageRange | undefined {
  const values = ['start', 'end'].map((key) => params.getAll(key));
  if (values.some((value) => value.length !== 1 || !/^\d+$/.test(value[0]!)))
    return;
  const [start, end] = values.map((value) => Number(value[0]));
  if (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start! >= 0 &&
    end! > start! &&
    end! <= length
  ) {
    return { start: start!, end: end! };
  }
}

export function selectedPassage(
  element: HTMLElement,
): PassageRange | undefined {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const selected = selection.getRangeAt(0);
  if (
    !element.contains(selected.startContainer) ||
    !element.contains(selected.endContainer)
  )
    return;
  const before = selected.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(selected.startContainer, selected.startOffset);
  const start = before.toString().length;
  return { start, end: start + selected.toString().length };
}

function rangeAt(element: HTMLElement, offset: number): Range | undefined {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (offset < length) {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      return range;
    }
    offset -= length;
  }
}

function readingTop(element: HTMLElement) {
  const toolbar = element
    .closest('.writing-route')
    ?.querySelector('.wr-reader-toolbar, .wr-compare-switch');
  return Math.max(88, (toolbar?.getBoundingClientRect().bottom ?? 0) + 24);
}

export function scrollToPassage(
  element: HTMLElement,
  offset: number,
  top = readingTop(element),
) {
  const target = rangeAt(element, offset)?.getBoundingClientRect();
  if (target?.height)
    window.scrollBy({ top: target.top - top, behavior: 'instant' });
}

// Persist a character and its screen position across tabs and viewport changes.
// Explicit source links always win over this record.
export function useReadingPosition(
  element: Ref<HTMLElement | undefined>,
  key: Ref<string>,
  url: URL,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let restoring = false;
  let disposed = false;
  let frameObserver: MutationObserver | undefined;
  const storageKey = () => `sth:writing:reading:${key.value}`;

  function remember() {
    if (!element.value || !key.value || restoring) return;
    const body = element.value;
    const rect = body.getBoundingClientRect();
    const top = readingTop(body);
    if (rect.top > innerHeight || rect.bottom < top) return;
    let low = 0;
    let high = (body.textContent?.length ?? 0) - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const point = rangeAt(body, middle)?.getBoundingClientRect();
      if (!point?.height || point.top < top) low = middle + 1;
      else high = middle;
    }
    const position = rangeAt(body, low)?.getBoundingClientRect();
    if (position?.height) {
      try {
        localStorage.setItem(
          storageKey(),
          JSON.stringify({ offset: low, top: position.top }),
        );
      } catch {
        /* Reading remains available when persistent storage is unavailable. */
      }
    }
  }

  async function restore(explicit = true) {
    if (!element.value || !key.value) return;
    restoring = true;
    await nextTick();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (disposed || !element.value) return;
        const body = element.value;
        const exact = passageRange(
          url.searchParams,
          body.textContent?.length ?? 0,
        );
        let position: ReadingPosition | undefined;
        try {
          position = JSON.parse(localStorage.getItem(storageKey()) ?? 'null');
        } catch {
          /* Ignore unavailable storage and malformed reading records. */
        }
        if (exact && explicit) {
          body
            .querySelector<HTMLElement>('mark')
            ?.focus({ preventScroll: true });
          scrollToPassage(body, exact.start, readingTop(body) + 48);
        } else if (url.hash && explicit) {
          let target: HTMLElement | null = null;
          try {
            target = document.getElementById(
              decodeURIComponent(url.hash.slice(1)),
            );
          } catch {
            /* Ignore malformed anchors. */
          }
          if (target instanceof HTMLDetailsElement) target.open = true;
          target?.scrollIntoView({ block: 'start', behavior: 'instant' });
        } else if (
          position &&
          Number.isSafeInteger(position.offset) &&
          position.offset >= 0 &&
          position.offset < (body.textContent?.length ?? 0) &&
          Number.isFinite(position.top)
        ) {
          scrollToPassage(
            body,
            position.offset,
            Math.max(readingTop(body), Math.min(innerHeight / 2, position.top)),
          );
        }
        restoring = false;
      });
    });
  }

  function onScroll() {
    clearTimeout(timer);
    timer = setTimeout(remember, 120);
  }
  watch([element, key], () => restore(), { flush: 'post' });
  onMounted(() => {
    window.addEventListener('scroll', onScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener('pagehide', remember);
    document.addEventListener('click', remember, true);
    const frame = element.value?.closest('.manuscript-frame');
    if (frame) {
      frameObserver = new MutationObserver(() => {
        if (element.value?.getClientRects().length) void restore(false);
      });
      frameObserver.observe(frame, {
        attributes: true,
        attributeFilter: ['data-pane', 'class'],
      });
    }
  });
  onBeforeUnmount(() => {
    remember();
    disposed = true;
    frameObserver?.disconnect();
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('pagehide', remember);
    document.removeEventListener('click', remember, true);
  });
  return { remember, restore };
}

export function returnHref(url: URL, fallback: string): string {
  const raw = url.searchParams.get('returnTo');
  if (!raw) return fallback;
  try {
    const destination = new URL(raw, url);
    if (destination.origin === url.origin && destination.href !== url.href) {
      return destination.pathname + destination.search + destination.hash;
    }
  } catch {
    /* Use the scene or chapter when the supplied return address is invalid. */
  }
  return fallback;
}
