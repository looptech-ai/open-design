// @ts-nocheck
//
// Frontend snapshot importer.
//
// Accepts a `.zip` whose root contains a `manifest.json` file alongside the
// snapshot tree. The manifest must declare:
//
//   {
//     "metadata": { "kind": "frontend-snapshot", ... }
//   }
//
// Every other entry inside the archive is treated as a file under the project
// root. Path traversal, absolute paths, encrypted entries, oversized files,
// and unknown compression methods are all rejected up front.
//
// On success the function returns the chosen `entryFile` (preferred entry
// HTML), the list of extracted files (relative paths), and the parsed
// manifest so callers can persist project metadata.
//
// This module is intentionally vendor-neutral: it is the generic on-disk
// shape any client can produce to ingest a frontend snapshot. The legacy
// alias route in server.ts keeps prior producers working without changes.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { validateProjectPath } from './projects.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const MAX_FILES = 1000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

const MANIFEST_NAME = 'manifest.json';
const EXPECTED_MANIFEST_KIND = 'frontend-snapshot';

export async function importFrontendSnapshotZip(zipPath, projectDir) {
  const zip = await readFile(zipPath);
  const entries = readCentralDirectory(zip);

  let manifestRaw = null;
  const files = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const relPath = sanitizeZipPath(entry.name);

    if (entry.uncompressedSize > MAX_FILE_BYTES) {
      throw new Error(`zip file too large: ${relPath}`);
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('zip is too large');

    const body = readEntryBody(zip, entry);
    if (body.length !== entry.uncompressedSize) {
      throw new Error(`zip entry size mismatch: ${relPath}`);
    }

    if (relPath === MANIFEST_NAME) {
      if (body.length > MAX_MANIFEST_BYTES) {
        throw new Error('manifest.json is too large');
      }
      manifestRaw = body.toString('utf8');
      continue;
    }

    if (files.length >= MAX_FILES) {
      throw new Error('zip contains too many files');
    }
    files.push({ path: relPath, body });
  }

  if (manifestRaw === null) {
    throw new Error(`zip is missing required ${MANIFEST_NAME}`);
  }
  if (files.length === 0) {
    throw new Error('zip contains no project files');
  }

  const manifest = parseManifest(manifestRaw);
  const entryFile = chooseEntryFile(
    files.map((f) => f.path),
    manifest,
  );
  if (!entryFile) {
    throw new Error('zip does not declare or contain an entry file');
  }

  await mkdir(projectDir, { recursive: true });
  for (const f of files) {
    const target = safeJoin(projectDir, f.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.body);
  }

  return {
    entryFile,
    files: files.map((f) => f.path),
    manifest,
  };
}

function parseManifest(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest.json must be a JSON object');
  }
  const metadata = parsed.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('manifest.json is missing metadata object');
  }
  if (metadata.kind !== EXPECTED_MANIFEST_KIND) {
    throw new Error(
      `manifest.json metadata.kind must be "${EXPECTED_MANIFEST_KIND}"`,
    );
  }
  return parsed;
}

function readCentralDirectory(zip) {
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

function findEndOfCentralDirectory(zip) {
  const min = Math.max(0, zip.length - 0xffff - 22);
  for (let i = zip.length - 22; i >= min; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('invalid zip: missing central directory');
}

function readEntryBody(zip, entry) {
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

function sanitizeZipPath(name) {
  if (name.includes('\0')) throw new Error('invalid zip file name');
  if (/^[A-Za-z]:/.test(name) || name.startsWith('/')) {
    throw new Error('absolute zip paths are not allowed');
  }
  return validateProjectPath(name);
}

function chooseEntryFile(paths, manifest) {
  const declared =
    typeof manifest?.metadata?.entryFile === 'string'
      ? manifest.metadata.entryFile
      : null;
  if (declared && paths.includes(declared)) return declared;

  const html = paths.filter((p) => /\.html?$/i.test(p));
  if (html.length === 0) return null;
  const lower = new Map(html.map((p) => [p.toLowerCase(), p]));
  return (
    lower.get('index.html') ??
    html.find((p) => !p.includes('/')) ??
    html[0] ??
    null
  );
}

function safeJoin(root, relPath) {
  const target = path.resolve(root, relPath);
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error('path escapes project dir');
  }
  return target;
}
