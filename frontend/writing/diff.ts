export interface DiffLine {
  text: string;
  changed: boolean;
}
export interface ComparedParagraph {
  left?: DiffLine;
  right?: DiffLine;
  leftIndex?: number;
  rightIndex?: number;
}

// LCS on lines keeps unchanged paragraphs stable. Very long manuscripts use a
// bounded prefix/suffix comparison so the editor never allocates a huge matrix.
export function compareLines(
  left: string,
  right: string,
): { left: DiffLine[]; right: DiffLine[]; paragraphs: ComparedParagraph[] } {
  const a = left.split('\n');
  const b = right.split('\n');
  const sameA = new Set<number>();
  const sameB = new Set<number>();
  const matches: [number, number][] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    matches.push([start, start]);
    sameA.add(start);
    sameB.add(start);
    start++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    matches.push([endA, endB]);
    sameA.add(endA--);
    sameB.add(endB--);
  }
  if ((endA - start + 1) * (endB - start + 1) <= 160_000) {
    const rows = Array.from(
      { length: endA - start + 2 },
      () => new Uint16Array(endB - start + 2),
    );
    for (let i = endA; i >= start; i--) {
      for (let j = endB; j >= start; j--) {
        rows[i - start]![j - start] =
          a[i] === b[j]
            ? rows[i - start + 1]![j - start + 1]! + 1
            : Math.max(
                rows[i - start + 1]![j - start]!,
                rows[i - start]![j - start + 1]!,
              );
      }
    }
    let i = start;
    let j = start;
    while (i <= endA && j <= endB) {
      if (a[i] === b[j]) {
        matches.push([i, j]);
        sameA.add(i++);
        sameB.add(j++);
      } else if (
        rows[i - start + 1]![j - start]! >= rows[i - start]![j - start + 1]!
      )
        i++;
      else j++;
    }
  }
  const linesA = a.map((text, i) => ({ text, changed: !sameA.has(i) }));
  const linesB = b.map((text, i) => ({ text, changed: !sameB.has(i) }));
  const paragraphs: ComparedParagraph[] = [];
  let previousA = 0;
  let previousB = 0;
  for (const [nextA, nextB] of [
    ...matches.sort((x, y) => x[0] - y[0]),
    [a.length, b.length],
  ]) {
    const count = Math.max(nextA! - previousA, nextB! - previousB);
    for (let i = 0; i < count; i++) {
      const leftIndex = previousA + i < nextA! ? previousA + i : undefined;
      const rightIndex = previousB + i < nextB! ? previousB + i : undefined;
      paragraphs.push({
        left: leftIndex === undefined ? undefined : linesA[leftIndex],
        right: rightIndex === undefined ? undefined : linesB[rightIndex],
        leftIndex,
        rightIndex,
      });
    }
    if (nextA! < a.length)
      paragraphs.push({
        left: linesA[nextA!],
        right: linesB[nextB!],
        leftIndex: nextA,
        rightIndex: nextB,
      });
    previousA = nextA! + 1;
    previousB = nextB! + 1;
  }
  return { left: linesA, right: linesB, paragraphs };
}
