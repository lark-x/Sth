import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Type, type Static } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';

export const maxAssetBytes = 8 * 1024 * 1024;
const maxEncodedLength = 4 * Math.ceil(maxAssetBytes / 3);
const strict = { additionalProperties: false };
const kind = Type.Union([Type.Literal('image'), Type.Literal('audio')]);
const id = Type.String({ minLength: 1, maxLength: 128 });
const name = Type.String({ minLength: 1, maxLength: 240 });
const metadata = Type.Object({ assetId: id, kind, name: Type.Optional(name), contentType: Type.String(),
  byteLength: Type.Integer({ minimum: 1 }), sha256: Type.String(), href: Type.String() }, strict);
type Asset = Static<typeof metadata>;

export const assetsDDL = `CREATE TABLE IF NOT EXISTS workspace_assets (
  asset_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('image','audio')),
  name TEXT, content_type TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND ${maxAssetBytes}),
  bytes BLOB NOT NULL CHECK(length(bytes) = byte_length)
) STRICT;`;

function detectType(bytes: Buffer) {
  const prefix = bytes.toString('latin1', 0, 12);
  if (prefix.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (prefix.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.endsWith('WEBP')) return 'image/webp';
  if (prefix.startsWith('RIFF') && prefix.endsWith('WAVE')) return 'audio/wav';
  if (prefix.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)) return 'audio/mpeg';
  if (prefix.startsWith('fLaC')) return 'audio/flac';
  if (prefix.startsWith('OggS') && (bytes.subarray(28, 36).toString('ascii') === 'OpusHead'
    || bytes.includes(Buffer.from('\x01vorbis', 'latin1'), 27))) return 'audio/ogg';
  return undefined;
}

const aliases: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg', 'audio/x-flac': 'audio/flac', 'image/jpg': 'image/jpeg' };
const columns = 'asset_id AS assetId, kind, name, content_type AS contentType, byte_length AS byteLength, sha256';
function metadataFor(row: Record<string, unknown>): Asset {
  return { assetId: String(row.assetId), kind: row.kind as Asset['kind'],
    ...(row.name == null ? {} : { name: String(row.name) }), contentType: String(row.contentType),
    byteLength: Number(row.byteLength), sha256: String(row.sha256), href: `/api/web/assets/${row.assetId}/content` };
}

function missing(): never { throw new OperationError(404, 'asset_not_found', 'The requested image or audio asset does not exist.'); }

export function readAssetMetadata(db: DatabaseSync, assetId: string) {
  const row = db.prepare(`SELECT ${columns} FROM workspace_assets WHERE asset_id = ?`).get(assetId);
  return metadataFor(row ?? missing());
}

export function readAssetBinary(db: DatabaseSync, assetId: string) {
  const row = db.prepare(`SELECT ${columns}, bytes FROM workspace_assets WHERE asset_id = ?`).get(assetId);
  if (!row) return missing();
  return { ...metadataFor(row), bytes: Buffer.from(row.bytes as Uint8Array) };
}

export const assetOperations = [
  defineOperation({ id: 'asset.import', effect: 'write',
    description: 'Import an immutable image (PNG, JPEG, GIF, WebP) or audio file (WAV, MP3, Ogg Opus/Vorbis, FLAC). Provide canonical base64 without a data URL, up to 8 MiB decoded. Identical bytes reuse the first asset. Use its assetId in character entry blocks.',
    inputSchema: Type.Object({ contentType: Type.String({ minLength: 1, maxLength: 100 }),
      data: Type.String({ minLength: 4, maxLength: maxEncodedLength }), name: Type.Optional(name) }, strict), outputSchema: metadata,
    run(input, { db }) {
      const bytes = Buffer.from(input.data, 'base64');
      if (!bytes.length || bytes.length > maxAssetBytes || bytes.toString('base64') !== input.data) {
        throw new OperationError(400, 'asset_invalid_data', 'Supply canonical base64 of a file up to 8 MiB.');
      }
      const requested = input.contentType.trim().toLowerCase();
      const contentType = detectType(bytes);
      if (!contentType || contentType !== (aliases[requested] ?? requested)) {
        throw new OperationError(415, 'asset_unsupported_type', 'The file signature must match a supported image or audio MIME type.');
      }
      if (input.name !== undefined && (!input.name.trim() || /[\p{Cc}\p{Surrogate}]/u.test(input.name))) {
        throw new OperationError(400, 'asset_invalid_name', 'Provide a printable file name.');
      }
      const sha = createHash('sha256').update(bytes).digest('hex');
      const existing = db.prepare('SELECT asset_id FROM workspace_assets WHERE sha256=?').get(sha);
      if (existing) return readAssetMetadata(db, String(existing.asset_id));
      const assetId = randomUUID();
      db.prepare(`INSERT INTO workspace_assets(asset_id,kind,name,content_type,sha256,byte_length,bytes) VALUES(?,?,?,?,?,?,?)`)
        .run(assetId, contentType.split('/')[0], input.name?.trim() ?? null, contentType, sha, bytes.length, bytes);
      return readAssetMetadata(db, assetId);
    },
  }),
  defineOperation({ id: 'asset.read', effect: 'read', description: 'Read immutable metadata and the owner content link of an imported asset.',
    inputSchema: Type.Object({ assetId: id }, strict), outputSchema: metadata,
    run({ assetId }, { db }) { return readAssetMetadata(db, assetId); },
  }),
  defineOperation({ id: 'asset.list', effect: 'read', description: 'List reusable imported images or audio in insertion order. Page with limit and offset.',
    inputSchema: Type.Object({ kind: Type.Optional(kind), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) }, strict),
    outputSchema: Type.Object({ items: Type.Array(metadata) }, strict),
    run({ kind, limit = 20, offset = 0 }, { db }) {
      return { items: db.prepare(`SELECT ${columns} FROM workspace_assets WHERE (? IS NULL OR kind=?) ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(kind ?? null, kind ?? null, limit, offset).map(metadataFor) };
    },
  }),
];
