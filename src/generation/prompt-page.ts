import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';
import type { PromptPage, PromptPageInput } from './contracts.ts';
import { readGenerationPrompt } from './storage.ts';

const maxFragmentCost = 36_000;

export function readPromptPage(db: DatabaseSync, { generationId, section = 'messages', cursor = 0 }: PromptPageInput): PromptPage {
  const json = JSON.stringify(readGenerationPrompt(db, generationId)[section]);
  const totalLength = json.length;
  // The serialized array already escapes any unpaired surrogates.
  const firstUnit = json.charCodeAt(cursor);
  if (cursor >= totalLength || (firstUnit >= 0xdc00 && firstUnit <= 0xdfff)) {
    throw new OperationError(400, 'generation_prompt_cursor_invalid', 'Use the nextCursor from a page of this generation and section.');
  }

  let end = cursor;
  let cost = 0;
  // Budget for both MCP structuredContent and its JSON text copy, including another
  // layer of escaping and serializers that write non-ASCII as Unicode escapes.
  for (const character of json.slice(cursor)) {
    const unit = character.charCodeAt(0);
    if (unit >= 0x7f) cost += 13 * character.length;
    else if (character === '"' || character === '\\') cost += 6;
    else cost += 2;
    if (cost > maxFragmentCost) break;
    end += character.length;
  }

  return { generationId, section, start: cursor, end, totalLength, fragment: json.slice(cursor, end),
    nextCursor: end === totalLength ? null : end };
}
