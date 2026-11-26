import { OperationError } from '../core/index.ts';
import type { SourceRange } from './contracts.ts';

function splitsSurrogate(body: string, offset: number) {
  // Stored source text is well-formed, so a low surrogate always follows its high surrogate.
  const code = body.charCodeAt(offset);
  return code >= 0xdc00 && code <= 0xdfff;
}

export function assertSourceRange(body: string, { start, end }: SourceRange) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || start >= end || end > body.length || splitsSurrogate(body, start) || splitsSurrogate(body, end)) {
    throw new OperationError(400, 'source_range_invalid', 'Select a nonempty UTF-16 range within the original body without splitting a surrogate pair.');
  }
}

export function sourceContextRange(body: string, range: SourceRange, contextChars: number): SourceRange {
  assertSourceRange(body, range);
  const start = Math.max(0, range.start - contextChars);
  const end = Math.min(body.length, range.end + contextChars);
  return { start: splitsSurrogate(body, start) ? start - 1 : start, end: splitsSurrogate(body, end) ? end + 1 : end };
}

export function sourceMatches(body: string, query: string, limit: number, offset: number): SourceRange[] {
  const matches: SourceRange[] = [];
  let start = body.indexOf(query);
  for (let occurrence = 0; start !== -1 && matches.length < limit; occurrence++) {
    if (occurrence >= offset) matches.push({ start, end: start + query.length });
    start = body.indexOf(query, start + 1);
  }
  return matches;
}
