import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import { OperationError } from '../core/index.ts';
import {
  SourcePinOwnerSchema, SourcePinsSchema, sourceHref,
  type LinkedSourcePin, type SourcePin, type SourcePinOwner, type SourcePinOwnerKey,
} from './contracts.ts';
import { assertSourceRange } from './ranges.ts';
import { assertSourceText, readSource, sourcePinRows, type SourcePinRow } from './storage.ts';

export function validateSourcePin<T extends SourcePin>(db: DatabaseSync, pin: T): T & { href: string } {
  assertSourceText(pin.sourceId, pin.excerpt);
  const source = readSource(db, pin.sourceId, pin.revision);
  const { range, excerpt } = pin;
  if (range !== undefined) assertSourceRange(source.body, range);
  const matches = range === undefined ? source.body.includes(excerpt) : source.body.slice(range.start, range.end) === excerpt;
  if (!matches) {
    throw new OperationError(400, 'source_excerpt_mismatch',
      `The excerpt does not match source ${pin.sourceId} at revision ${pin.revision}${range ? ' in the selected range' : ''}.`);
  }
  return { ...pin, href: source.href };
}

/** Validate exact excerpts against their specified revisions, preserving the input order. */
export function validateSourcePins(db: DatabaseSync, pins: readonly SourcePin[]): LinkedSourcePin[] {
  if (!Value.Check(SourcePinsSchema, pins)) {
    throw new OperationError(400, 'source_pins_invalid', 'Provide distinct source pins with a source ID, revision, and excerpt.');
  }
  return pins.map(pin => validateSourcePin(db, pin));
}

/** Write once per owner revision in the same transaction as the owner and its receipt. */
export function writeSourcePins(db: DatabaseSync, owner: SourcePinOwner, pins: readonly SourcePin[]): LinkedSourcePin[] {
  if (!db.isTransaction) {
    throw new OperationError(500, 'source_pin_transaction_required', 'Persist source pins in the owner revision transaction.');
  }
  if (!Value.Check(SourcePinOwnerSchema, owner)) {
    throw new OperationError(500, 'source_pin_owner_invalid', 'Provide a valid source pin owner revision and internal link.');
  }
  assertSourceText(owner.id, owner.title, owner.projectId ?? '');
  const linked = validateSourcePins(db, pins);
  const inserted = db.prepare(`INSERT INTO source_pin_owners (owner_kind, owner_id, owner_revision, title, href, project_id)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner_kind, owner_id, owner_revision) DO NOTHING`)
    .run(owner.kind, owner.id, owner.revision, owner.title, owner.href, owner.projectId ?? null);
  if (inserted.changes === 0) {
    throw new OperationError(409, 'source_pin_owner_conflict', 'Source pins already exist for this owner revision.');
  }
  const insertPin = db.prepare(`INSERT INTO source_pins
    (owner_kind, owner_id, owner_revision, position, source_id, source_revision, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertRangedPin = db.prepare(`INSERT INTO source_ranged_pins
    (owner_kind, owner_id, owner_revision, position, source_id, source_revision, excerpt, range_start, range_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  linked.forEach((pin, position) => {
    const values = [owner.kind, owner.id, owner.revision, position, pin.sourceId, pin.revision, pin.excerpt] as const;
    if (pin.range) insertRangedPin.run(...values, pin.range.start, pin.range.end);
    else insertPin.run(...values);
  });
  return linked;
}

export function toSourcePin(row: SourcePinRow): LinkedSourcePin {
  return {
    sourceId: row.source_id,
    revision: row.source_revision,
    excerpt: row.excerpt,
    href: sourceHref(row.source_id, row.source_revision),
    ...(row.range_start === null || row.range_end === null ? {} : { range: { start: row.range_start, end: row.range_end } }),
  };
}

export function readSourcePins(db: DatabaseSync, owner: SourcePinOwnerKey): LinkedSourcePin[] {
  const rows = db.prepare(`SELECT source_id, source_revision, excerpt, range_start, range_end FROM (${sourcePinRows})
    WHERE owner_kind = ? AND owner_id = ? AND owner_revision = ? ORDER BY position`)
    .all(owner.kind, owner.id, owner.revision) as SourcePinRow[];
  return rows.map(toSourcePin);
}
