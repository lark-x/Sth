export interface DiffLine { text: string; changed: boolean }

// LCS on lines keeps unchanged paragraphs stable. Very long manuscripts use a
// bounded prefix/suffix comparison so the editor never allocates a huge matrix.
export function compareLines(left: string, right: string): { left: DiffLine[]; right: DiffLine[] } {
  const a = left.split('\n');
  const b = right.split('\n');
  const sameA = new Set<number>();
  const sameB = new Set<number>();
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) { sameA.add(start); sameB.add(start); start++; }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { sameA.add(endA--); sameB.add(endB--); }
  if ((endA - start + 1) * (endB - start + 1) <= 160_000) {
    const rows = Array.from({ length: endA - start + 2 }, () => new Uint16Array(endB - start + 2));
    for (let i = endA; i >= start; i--) {
      for (let j = endB; j >= start; j--) {
        rows[i - start]![j - start] = a[i] === b[j] ? rows[i - start + 1]![j - start + 1]! + 1
          : Math.max(rows[i - start + 1]![j - start]!, rows[i - start]![j - start + 1]!);
      }
    }
    let i = start;
    let j = start;
    while (i <= endA && j <= endB) {
      if (a[i] === b[j]) { sameA.add(i++); sameB.add(j++); }
      else if (rows[i - start + 1]![j - start]! >= rows[i - start]![j - start + 1]!) i++;
      else j++;
    }
  }
  return { left: a.map((text, i) => ({ text, changed: !sameA.has(i) })), right: b.map((text, i) => ({ text, changed: !sameB.has(i) })) };
}
