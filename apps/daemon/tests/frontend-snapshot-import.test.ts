// @ts-nocheck
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importFrontendSnapshotZip } from '../src/frontend-snapshot-import.js';

// Tiny zero-dependency ZIP writer matching what the importer parses.
// `entries` is `[{ name, body, store? }]`. `store` (no compression) is the
// default; pass `store: false` to use raw deflate.
function buildZip(entries) {
  const LOCAL_SIG = 0x04034b50;
  const CENTRAL_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body)
      ? entry.body
      : Buffer.from(entry.body, 'utf8');
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const store = entry.store !== false;
    const method = store ? 0 : 8;
    const compressed = store ? body : deflateRawSync(body);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_SIG, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mtime
    localHeader.writeUInt16LE(0, 12); // mdate
    localHeader.writeUInt32LE(0, 14); // crc — importer ignores
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    localChunks.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_SIG, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12); // mtime
    centralHeader.writeUInt16LE(0, 14); // mdate
    centralHeader.writeUInt32LE(0, 16); // crc
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralChunks.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const localPart = Buffer.concat(localChunks);
  const centralPart = Buffer.concat(centralChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk where central starts
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([localPart, centralPart, eocd]);
}

describe('importFrontendSnapshotZip', () => {
  let workDir;
  let zipPath;
  let projectDir;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'fs-import-'));
    zipPath = path.join(workDir, 'snapshot.zip');
    projectDir = path.join(workDir, 'project');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeZip(entries) {
    await writeFile(zipPath, buildZip(entries));
  }

  it('extracts files when the manifest declares kind frontend-snapshot', async () => {
    const manifest = {
      metadata: {
        kind: 'frontend-snapshot',
        name: 'My snapshot',
        entryFile: 'index.html',
      },
    };
    await writeZip([
      { name: 'manifest.json', body: JSON.stringify(manifest) },
      { name: 'index.html', body: '<html><body>hi</body></html>' },
      { name: 'assets/app.css', body: 'body { color: red; }' },
    ]);

    const result = await importFrontendSnapshotZip(zipPath, projectDir);

    expect(result.entryFile).toBe('index.html');
    expect(result.files.sort()).toEqual(['assets/app.css', 'index.html']);
    expect(result.manifest.metadata.name).toBe('My snapshot');

    const writtenHtml = await readFile(path.join(projectDir, 'index.html'), 'utf8');
    expect(writtenHtml).toContain('hi');
    const writtenCss = await readFile(
      path.join(projectDir, 'assets', 'app.css'),
      'utf8',
    );
    expect(writtenCss).toContain('color: red');
  });

  it('falls back to index.html when the manifest does not declare an entry file', async () => {
    const manifest = { metadata: { kind: 'frontend-snapshot' } };
    await writeZip([
      { name: 'manifest.json', body: JSON.stringify(manifest) },
      { name: 'page.html', body: '<html></html>' },
      { name: 'index.html', body: '<html>root</html>' },
    ]);

    const result = await importFrontendSnapshotZip(zipPath, projectDir);
    expect(result.entryFile).toBe('index.html');
  });

  it('rejects archives missing manifest.json', async () => {
    await writeZip([
      { name: 'index.html', body: '<html></html>' },
    ]);

    await expect(importFrontendSnapshotZip(zipPath, projectDir)).rejects.toThrow(
      /missing required manifest\.json/,
    );
  });

  it('rejects manifests with the wrong metadata.kind', async () => {
    const manifest = { metadata: { kind: 'design-snapshot' } };
    await writeZip([
      { name: 'manifest.json', body: JSON.stringify(manifest) },
      { name: 'index.html', body: '<html></html>' },
    ]);

    await expect(importFrontendSnapshotZip(zipPath, projectDir)).rejects.toThrow(
      /metadata\.kind must be "frontend-snapshot"/,
    );
  });

  it('rejects archives with no project files alongside the manifest', async () => {
    const manifest = { metadata: { kind: 'frontend-snapshot' } };
    await writeZip([{ name: 'manifest.json', body: JSON.stringify(manifest) }]);

    await expect(importFrontendSnapshotZip(zipPath, projectDir)).rejects.toThrow(
      /no project files/,
    );
  });

  it('rejects malformed manifest JSON', async () => {
    await writeZip([
      { name: 'manifest.json', body: '{not-json' },
      { name: 'index.html', body: '<html></html>' },
    ]);

    await expect(importFrontendSnapshotZip(zipPath, projectDir)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('rejects path-traversal entries', async () => {
    const manifest = { metadata: { kind: 'frontend-snapshot' } };
    await writeZip([
      { name: 'manifest.json', body: JSON.stringify(manifest) },
      { name: '../escape.txt', body: 'bad' },
    ]);

    await expect(importFrontendSnapshotZip(zipPath, projectDir)).rejects.toThrow();
  });

  it('rejects absolute paths in archive entries', async () => {
    const manifest = { metadata: { kind: 'frontend-snapshot' } };
    await writeZip([
      { name: 'manifest.json', body: JSON.stringify(manifest) },
      { name: '/etc/passwd', body: 'bad' },
    ]);

    await expect(importFrontendSnapshotZip(zipPath, projectDir)).rejects.toThrow(
      /absolute zip paths/,
    );
  });

  it('handles deflate-compressed entries', async () => {
    const manifest = { metadata: { kind: 'frontend-snapshot' } };
    const html = '<html>'.repeat(200);
    await writeZip([
      { name: 'manifest.json', body: JSON.stringify(manifest), store: false },
      { name: 'index.html', body: html, store: false },
    ]);

    const result = await importFrontendSnapshotZip(zipPath, projectDir);
    expect(result.entryFile).toBe('index.html');
    const written = await readFile(path.join(projectDir, 'index.html'), 'utf8');
    expect(written).toBe(html);
  });

  it('rejects manifest files larger than the safety cap', async () => {
    const huge = JSON.stringify({
      metadata: { kind: 'frontend-snapshot', filler: 'x'.repeat(300_000) },
    });
    await writeZip([
      { name: 'manifest.json', body: huge },
      { name: 'index.html', body: '<html></html>' },
    ]);

    await expect(importFrontendSnapshotZip(zipPath, projectDir)).rejects.toThrow(
      /manifest\.json is too large/,
    );
  });

  it('writes the entry file to disk on success', async () => {
    const manifest = { metadata: { kind: 'frontend-snapshot' } };
    await writeZip([
      { name: 'manifest.json', body: JSON.stringify(manifest) },
      { name: 'index.html', body: '<html>ok</html>' },
    ]);

    await importFrontendSnapshotZip(zipPath, projectDir);
    const info = await stat(path.join(projectDir, 'index.html'));
    expect(info.isFile()).toBe(true);
  });
});
