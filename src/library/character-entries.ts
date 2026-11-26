import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { readAssetMetadata } from '../assets/index.ts';
import { OperationError } from '../core/index.ts';
import { readJudgment } from '../sources/judgments.ts';
import { readSource } from '../sources/storage.ts';
import { readDraft, readSceneSummary } from '../story/storage.ts';
import type { AdoptionEntry, AuthorEntry, CharacterEntry, CharacterReference } from './character-contracts.ts';
import { locateExcerpt } from './reference-range.ts';
import { assertStorableText, readCharacter, readCharacterRow, readDiary, toCharacter, toCharacterLink,
  writeCharacterRevision, type CharacterRow } from './storage.ts';

type Resource = Pick<CharacterReference, 'kind' | 'id'> & { revision?: number };

function referenceText(db: DatabaseSync, { kind, id, revision }: Resource, quote: boolean): (string | undefined)[] {
  switch (kind) {
    case 'source': return [readSource(db, id, revision).body];
    case 'draft': return [readDraft(db, id, revision).body];
    case 'diary': return [readDiary(db, id, revision).body];
    case 'judgment': return [readJudgment(db, id, revision).statement];
    case 'scene': {
      const { title, time, place, adopted } = readSceneSummary(db, id, revision);
      if (!quote) return [];
      return [title, time, place, adopted && readDraft(db, adopted.draftId, adopted.revision).body];
    }
    case 'character': {
      const row = readCharacterRow(db, id, revision);
      if (!quote) return [];
      const { entries } = toCharacter(db, row);
      return [row.persona, ...entries.flatMap(entry => entry.blocks.flatMap(block => block.type === 'text' ? [block.text] : []))];
    }
  }
}

function normalizeReference(db: DatabaseSync, block: CharacterReference, adoption: boolean): CharacterReference {
  const { kind, id, revision, excerpt, range } = block;
  assertStorableText(id, excerpt);
  const mismatch = kind === 'source' ? 'source_excerpt_mismatch' : 'character_reference_excerpt_mismatch';
  if (range !== undefined && (kind === 'scene' || kind === 'character')) {
    throw new OperationError(400, 'character_reference_range_unsupported', 'Select an exact source, draft, diary, or judgment version for a text range.');
  }
  const text = referenceText(db, block, excerpt !== undefined || range !== undefined);
  if (!adoption && range === undefined) {
    if (excerpt !== undefined && !text.some(value => value?.includes(excerpt))) {
      throw new OperationError(400, mismatch, `The excerpt does not appear in ${kind} ${id} at revision ${revision}.`);
    }
    return block;
  }
  if (range === undefined && excerpt === undefined && kind !== 'judgment') {
    throw new OperationError(400, 'reference_range_required', 'Select an excerpt or range from the original text.');
  }
  const selection = locateExcerpt(text[0]!, excerpt, range ?? (excerpt === undefined ? { start: 0, end: text[0]!.length } : undefined), {
    mismatch, requireUnique: true,
  });
  if ((selection.excerpt?.length ?? 0) > 4_000) {
    throw new OperationError(400, 'character_reference_excerpt_too_long', 'Select at most 4,000 UTF-16 code units per excerpt.');
  }
  return { type: 'reference', kind, id, revision,
    ...(selection.excerpt === undefined ? {} : { excerpt: selection.excerpt, range: selection.range! }) };
}

export function prepareCharacterEntries(db: DatabaseSync, input: readonly AuthorEntry[]): CharacterEntry[] {
  const seen = new Set<string>();
  return input.map(({ entryId = randomUUID(), label, blocks }) => {
    assertStorableText(entryId, label);
    if (seen.has(entryId)) {
      throw new OperationError(400, 'character_duplicate_entry_id', `Entry ID ${entryId} is already in this character revision.`);
    }
    seen.add(entryId);
    const prepared = blocks.map(block => {
      switch (block.type) {
        case 'text':
          assertStorableText(block.text);
          return block;
        case 'image':
        case 'audio': {
          assertStorableText(block.assetId);
          const asset = readAssetMetadata(db, block.assetId);
          if (asset.kind !== block.type) {
            throw new OperationError(400, 'character_asset_kind_mismatch', `Asset ${block.assetId} is not ${block.type} media.`);
          }
          return block;
        }
        case 'reference': return normalizeReference(db, block, false);
      }
    });
    return { entryId, label, blocks: prepared };
  });
}

export function adoptCharacterEntries(db: DatabaseSync, input: {
  characterId: string; expectedRevision?: number; entries: AdoptionEntry[];
}) {
  const { characterId, expectedRevision, entries } = input;
  const current = readCharacter(db, characterId);
  const next = [...current.entries];
  for (const { label, text, references } of entries) {
    assertStorableText(label, text);
    const blocks: CharacterEntry['blocks'] = text === undefined ? [] : [{ type: 'text', text }];
    for (const { location, range, ...reference } of references) {
      if (range && location && !isDeepStrictEqual(range, location)) {
        throw new OperationError(400, 'reference_range_conflict', 'Supply matching range and location values or use one field.');
      }
      const block = normalizeReference(db, { type: 'reference', ...reference, range: range ?? location }, true);
      if (!blocks.some(existing => isDeepStrictEqual(existing, block))) blocks.push(block);
    }
    const name = label.trim();
    if (!next.some(entry => entry.label === name && isDeepStrictEqual(entry.blocks, blocks))) {
      next.push({ entryId: randomUUID(), label: name, blocks });
    }
  }
  if (next.length === current.entries.length) return current;
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    throw new OperationError(409, 'character_revision_conflict', `Character is at revision ${current.revision}. Read it before adopting entries.`);
  }
  writeCharacterRevision(db, characterId, current.revision + 1, current.authorName ?? '', current.persona, next);
  return readCharacter(db, characterId);
}

type BacklinkRow = Omit<CharacterRow, 'persona'> & {
  entry_id: string; label: string; block_index: number; block_json: string;
};

export function readCharacterBacklinks(db: DatabaseSync, options: Resource & { currentOnly?: boolean; limit?: number; offset?: number }) {
  const { kind, id, revision, currentOnly, limit = 20, offset = 0 } = options;
  assertStorableText(id);
  referenceText(db, options, false);
  const conditions = ['b.resource_kind = ?', 'b.resource_id = ?'];
  const parameters: (string | number)[] = [kind, id];
  if (revision !== undefined) {
    conditions.push('b.resource_revision = ?');
    parameters.push(revision);
  }
  if (currentOnly) {
    conditions.push('r.revision = (SELECT MAX(revision) FROM library_character_revisions WHERE character_id = r.character_id)');
  }
  const rows = db.prepare(`SELECT r.character_id, r.revision, r.name, c.project_id, e.entry_id, e.label,
      b.position AS block_index, b.block_json
    FROM library_character_entry_blocks b
    JOIN library_character_entries e ON e.character_id = b.character_id
      AND e.character_revision = b.character_revision AND e.position = b.entry_position
    JOIN library_character_revisions r ON r.character_id = b.character_id AND r.revision = b.character_revision
    JOIN library_characters c ON c.character_id = b.character_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY b.character_id, b.character_revision DESC, b.entry_position, b.position LIMIT ? OFFSET ?`)
    .all(...parameters, limit, offset) as BacklinkRow[];
  return rows.map(row => ({
    ...toCharacterLink(row, true), entryId: row.entry_id, label: row.label, blockIndex: row.block_index,
    reference: JSON.parse(row.block_json) as CharacterReference,
  }));
}
