// @ts-nocheck
//
// Minimal in-memory ZIP reader shared by all `/api/import/*` endpoints
// (currently `claude-design` and `lune-frontend-snapshot`). Lifted out of
// `claude-design-import.ts` so multiple importers can reuse the same
// streaming + safety logic without pulling a new dependency into the
// daemon's tightly-controlled deps tree.
//
// The reader is deliberately spec-minimal: it understands STORE (method 0)
// and DEFLATE (method 8) entries with up-front-known sizes, which is
// what every modern ZIP writer (including Lune's `node:zlib`-based one)
// emits by default. Encrypted entries are rejected. ZIP64 is not
// supported; the per-archive caps below make ZIP64 unreachable in
// practice.

import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { validateProjectPath } from './projects.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export const ZIP_DEFAULT_LIMITS = {
  maxFiles: 500,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
};

/**
 * Read every file entry out of a ZIP buffer. Caller is expected to
 * supply size limits — the defaults above are the ones the
 * claude-design import has shipped with since day one.
 *
 * @param {Buffer} zip
 * @param {{ maxFiles?: number, maxTotalBytes?: number, maxFileBytes?: number }} [limits]
 * @returns {{ path: string, body: Buffer }[]}
 */
export function readZipEntries(zip, limits = {}) {
  const maxFiles = limits.maxFiles ?? ZIP_DEFAULT_LIMITS.maxFiles;
  const maxTotalBytes = limits.maxTotalBytes ?? ZIP_DEFAULT_LIMITS.maxTotalBytes;
  const maxFileBytes = limits.maxFileBytes ?? ZIP_DEFAULT_LIMITS.maxFileBytes;

  const entries = readCentralDirectory(zip);
  const files = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (files.length >= maxFiles) throw new Error('zip contains too many files');
    const relPath = sanitizeZipPath(entry.name);
    if (entry.uncompressedSize > maxFileBytes) {
      throw new Error(`zip file too large: ${relPath}`);
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > maxTotalBytes) throw new Error('zip is too large');

    const body = readEntryBody(zip, entry);
    if (body.length !== entry.uncompressedSize) {
      throw new Error(`zip entry size mismatch: ${relPath}`);
    }
    files.push({ path: relPath, body });
  }

  return files;
}

export function readCentralDirectory(zip) {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralSize = zip.readUInt32LE(eocdOffset + 12);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize > zip.length) {
    throw new Error('invalid zip central directory');
  }

  const entries = [];
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('invalid zip central directory entry');
    }
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    if ((flags & 1) !== 0) throw new Error('encrypted zip entries are not supported');
    if (method !== 0 && method !== 8) {
      throw new Error(`unsupported zip compression method: ${method}`);
    }
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      isDirectory: name.endsWith('/'),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function findEndOfCentralDirectory(zip) {
  const min = Math.max(0, zip.length - 0xffff - 22);
  for (let i = zip.length - 22; i >= min; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('invalid zip: missing central directory');
}

export function readEntryBody(zip, entry) {
  const offset = entry.localOffset;
  if (zip.readUInt32LE(offset) !== LOCAL_SIG) {
    throw new Error(`invalid zip local header: ${entry.name}`);
  }
  const nameLen = zip.readUInt16LE(offset + 26);
  const extraLen = zip.readUInt16LE(offset + 28);
  const bodyStart = offset + 30 + nameLen + extraLen;
  const bodyEnd = bodyStart + entry.compressedSize;
  if (bodyEnd > zip.length) throw new Error(`zip entry exceeds archive: ${entry.name}`);
  const compressed = zip.slice(bodyStart, bodyEnd);
  if (entry.method === 0) return Buffer.from(compressed);
  return inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
}

export function sanitizeZipPath(name) {
  if (name.includes('\0')) throw new Error('invalid zip file name');
  if (/^[A-Za-z]:/.test(name) || name.startsWith('/')) {
    throw new Error('absolute zip paths are not allowed');
  }
  return validateProjectPath(name);
}

export function safeJoin(root, relPath) {
  const target = path.resolve(root, relPath);
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error('path escapes project dir');
  }
  return target;
}
