import { OperationError } from '../core/index.ts';
import type { SourceRange } from '../sources/contracts.ts';
import { assertSourceRange } from '../sources/ranges.ts';

export function locateExcerpt(body: string, excerpt: string | undefined, range: SourceRange | undefined, options: {
  mismatch: string; requireUnique?: boolean;
}) {
  if (range !== undefined) {
    assertSourceRange(body, range);
    const text = body.slice(range.start, range.end);
    if (!text.trim() || (excerpt !== undefined && text !== excerpt)) {
      throw new OperationError(400, options.mismatch, 'The excerpt does not match the selected range in the pinned revision.');
    }
    return { excerpt: text, range };
  }
  if (excerpt === undefined) return { excerpt, range };
  const start = body.indexOf(excerpt);
  if (start < 0) throw new OperationError(400, options.mismatch, 'The excerpt does not appear in the pinned revision.');
  if (body.includes(excerpt, start + 1)) {
    if (options.requireUnique) throw new OperationError(400, 'reference_range_required', 'Select the exact range for a repeated excerpt.');
    return { excerpt, range };
  }
  return { excerpt, range: { start, end: start + excerpt.length } };
}
