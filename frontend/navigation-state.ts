export interface ReadingPosition {
  href: string;
  x: number;
  y: number;
  focusMark: boolean;
}

const passageSelector = '#main #passage-body.wr-reader-prose';

export function readingPosition(): ReadingPosition | undefined {
  const passage = document.querySelector(passageSelector);
  if (!passage?.getClientRects().length) return;
  const mark = passage.querySelector('mark')?.getBoundingClientRect();
  return {
    href: location.href,
    x: window.scrollX,
    y: window.scrollY,
    focusMark: !!mark && mark.bottom > 0 && mark.top < window.innerHeight,
  };
}

export function restoreReadingPosition(position: ReadingPosition, main: HTMLElement) {
  let frame = 0;
  const observer = new MutationObserver(restoreWhenMounted);

  function restoreWhenMounted() {
    const passage = main.querySelector<HTMLElement>(passageSelector);
    if (!passage) return;
    observer.disconnect();
    let frames = 3;
    const afterReaderScroll = () => {
      if (--frames > 0) {
        frame = requestAnimationFrame(afterReaderScroll);
        return;
      }
      if (location.href !== position.href || !passage.getClientRects().length) return;
      const target = (position.focusMark && passage.querySelector<HTMLElement>('mark')) || passage;
      target.focus({ preventScroll: true });
      window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
    };
    frame = requestAnimationFrame(afterReaderScroll);
  }

  observer.observe(main, { childList: true, subtree: true });
  restoreWhenMounted();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}
