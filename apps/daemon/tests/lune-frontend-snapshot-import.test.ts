// @ts-nocheck
//
// Tests for the lune-frontend-snapshot importer + its `/api/import/lune-frontend-snapshot`
// route handler. Mirrors the layout of `tests/server-cors.test.ts` — small
// in-process Express app exposing only the route under test, no daemon
// boot, no SQLite. ZIPs are built in-memory with `node:zlib` (the same
// approach Lune's producer uses) so we don't need to ship a binary
// fixture in the OD repo.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// Node 20 (the version OD pins to) does not expose `crc32` from `node:zlib`
// (added in 22.2.0). The ZIP central directory requires a CRC32 of every
// uncompressed entry; computing it by hand keeps the test fixture builder
// independent of Node-version drift.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
import express from 'express';
import multer from 'multer';
import http from 'node:http';
import {
  importLuneFrontendSnapshotZip,
  validateManifest,
} from '../src/lune-frontend-snapshot-import.js';

// ---------------------------------------------------------------------------
// In-memory ZIP writer (STORE method — simplest valid ZIP that the
// importer's reader accepts; sidesteps DEFLATE round-tripping in the
// fixture builder so any failure here is unambiguously a reader bug, not
// a writer bug).
// ---------------------------------------------------------------------------

function buildZip(entries) {
  const localChunks = [];
  const central = [];
  let offset = 0;

  for (const { name, body } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = body instanceof Buffer ? body : Buffer.from(body, 'utf8');
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method = store
    localHeader.writeUInt16LE(0, 10); // mtime
    localHeader.writeUInt16LE(0, 12); // mdate
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localChunks.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

function buildLuneSnapshotZip(overrides = {}) {
  const manifest = {
    manifestVersion: '0.1.0',
    projectName: 'Lune',
    sourceRepoUrl: 'https://github.com/looptech-ai/lune',
    commitSha: 'abc1234',
    exportTimestamp: '2026-05-02T00:00:00Z',
    counts: {
      routes: 2,
      components: 1,
      designTokens: 1,
      screenshotsCaptured: 0,
      screenshotsSkipped: 2,
    },
    files: {
      routes: 'routes.json',
      components: 'components.json',
      designTokens: 'design-tokens.json',
      screenshots: 'screenshots/',
    },
    notes: ['fixture for OD round-trip test'],
    ...(overrides.manifest ?? {}),
  };
  const routes = {
    routes: [
      { path: '/', file: 'apps/web/app/page.tsx', group: null, dynamic: false, title: 'Home' },
      { path: '/dashboard', file: 'apps/web/app/dashboard/page.tsx', group: null, dynamic: false, title: 'Dashboard' },
    ],
  };
  const components = {
    components: [
      { name: 'Button', file: 'apps/web/components/button.tsx' },
    ],
  };
  const designTokens = { cssVariables: { '--lune-primary': '#0070f3' } };

  const baseEntries = [
    { name: 'manifest.json', body: JSON.stringify(manifest, null, 2) },
    { name: 'routes.json', body: JSON.stringify(routes, null, 2) },
    { name: 'components.json', body: JSON.stringify(components, null, 2) },
    { name: 'design-tokens.json', body: JSON.stringify(designTokens, null, 2) },
    { name: 'screenshots/.placeholder', body: 'no screenshots in this fixture' },
    { name: 'README.md', body: '# Lune snapshot (fixture)\n' },
  ];

  const entries = overrides.entries ?? baseEntries;
  return { zip: buildZip(entries), manifest, routes, components, designTokens };
}

// ---------------------------------------------------------------------------
// Direct importer tests
// ---------------------------------------------------------------------------

describe('importLuneFrontendSnapshotZip', () => {
  let workDir;
  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'lune-snap-test-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('round-trips a v0.1.0 fixture into a project dir', async () => {
    const { zip, manifest } = buildLuneSnapshotZip();
    const zipPath = path.join(workDir, 'snapshot.zip');
    await writeFile(zipPath, zip);

    const projectDir = path.join(workDir, 'project');
    const result = await importLuneFrontendSnapshotZip(zipPath, projectDir);

    expect(result.manifest.manifestVersion).toBe('0.1.0');
    expect(result.manifest.projectName).toBe(manifest.projectName);
    expect(result.routes.routes).toHaveLength(2);
    expect(result.components.components[0].name).toBe('Button');
    expect(result.designTokens.cssVariables['--lune-primary']).toBe('#0070f3');
    expect(result.files).toContain('manifest.json');
    expect(result.screenshots).toEqual([]);

    const persistedManifest = await readFile(
      path.join(projectDir, 'manifest.json'),
      'utf8',
    );
    expect(JSON.parse(persistedManifest).projectName).toBe('Lune');
  });

  it('rejects manifestVersion 0.2.0 with a schema-upgrade message', async () => {
    const { zip } = buildLuneSnapshotZip({
      manifest: { manifestVersion: '0.2.0', projectName: 'Lune' },
    });
    const zipPath = path.join(workDir, 'snapshot.zip');
    await writeFile(zipPath, zip);
    await expect(
      importLuneFrontendSnapshotZip(zipPath, path.join(workDir, 'project')),
    ).rejects.toThrow(/unsupported manifestVersion 0\.2\.0/);
  });

  it('rejects ZIP without manifest.json', async () => {
    const zip = buildZip([
      { name: 'routes.json', body: '{"routes":[]}' },
      { name: 'components.json', body: '{"components":[]}' },
      { name: 'design-tokens.json', body: '{"cssVariables":{}}' },
    ]);
    const zipPath = path.join(workDir, 'snapshot.zip');
    await writeFile(zipPath, zip);
    await expect(
      importLuneFrontendSnapshotZip(zipPath, path.join(workDir, 'project')),
    ).rejects.toThrow(/missing required file: manifest\.json/);
  });

  it('rejects non-ZIP body', async () => {
    const zipPath = path.join(workDir, 'not-a-zip.zip');
    await writeFile(zipPath, Buffer.from('totally not a zip file just plain text'));
    await expect(
      importLuneFrontendSnapshotZip(zipPath, path.join(workDir, 'project')),
    ).rejects.toThrow(/missing central directory/);
  });

  it('persists screenshots when present', async () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { zip } = buildLuneSnapshotZip({
      entries: [
        {
          name: 'manifest.json',
          body: JSON.stringify({
            manifestVersion: '0.1.0',
            projectName: 'Lune',
            counts: { routes: 1, components: 0, designTokens: 0, screenshotsCaptured: 1, screenshotsSkipped: 0 },
          }),
        },
        { name: 'routes.json', body: '{"routes":[{"path":"/","file":"a","group":null,"dynamic":false,"title":"Home"}]}' },
        { name: 'components.json', body: '{"components":[]}' },
        { name: 'design-tokens.json', body: '{"cssVariables":{}}' },
        { name: 'screenshots/home.png', body: fakePng },
      ],
    });
    const zipPath = path.join(workDir, 'snapshot.zip');
    await writeFile(zipPath, zip);
    const result = await importLuneFrontendSnapshotZip(zipPath, path.join(workDir, 'project'));
    expect(result.screenshots).toEqual([{ file: 'screenshots/home.png' }]);
    const written = await readFile(path.join(workDir, 'project', 'screenshots', 'home.png'));
    expect(written.equals(fakePng)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateManifest unit tests
// ---------------------------------------------------------------------------

describe('validateManifest', () => {
  it('accepts 0.1.0 and 0.1.99', () => {
    expect(() => validateManifest({ manifestVersion: '0.1.0', projectName: 'X' })).not.toThrow();
    expect(() => validateManifest({ manifestVersion: '0.1.99', projectName: 'X' })).not.toThrow();
  });

  it('rejects 0.2.0 and 1.0.0', () => {
    expect(() => validateManifest({ manifestVersion: '0.2.0', projectName: 'X' })).toThrow(/unsupported manifestVersion/);
    expect(() => validateManifest({ manifestVersion: '1.0.0', projectName: 'X' })).toThrow(/unsupported manifestVersion/);
  });

  it('rejects missing manifestVersion', () => {
    expect(() => validateManifest({ projectName: 'X' })).toThrow(/missing manifestVersion/);
  });

  it('rejects missing projectName', () => {
    expect(() => validateManifest({ manifestVersion: '0.1.0' })).toThrow(/missing projectName/);
  });
});

// ---------------------------------------------------------------------------
// Route handler test — wires the importer through Express+multer the same
// way server.ts does, hits it via fetch, and asserts the JSON response.
// ---------------------------------------------------------------------------

function makeTestApp(uploadDir, projectsDir) {
  const app = express();
  const upload = multer({ dest: uploadDir });
  app.post(
    '/api/import/lune-frontend-snapshot',
    upload.single('file'),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: 'zip file required' });
        if (!/\.zip$/i.test(req.file.originalname || '')) {
          return res.status(400).json({ error: 'expected a .zip file' });
        }
        const id = 'test-project';
        const imported = await importLuneFrontendSnapshotZip(
          req.file.path,
          path.join(projectsDir, id),
        );
        res.json({
          project: { id, name: imported.manifest.projectName },
          manifestVersion: imported.manifest.manifestVersion,
          files: imported.files,
          redirectUrl: `/projects/${id}`,
        });
      } catch (err) {
        res.status(400).json({ error: String(err?.message ?? err) });
      }
    },
  );
  return app;
}

describe('POST /api/import/lune-frontend-snapshot', () => {
  let server;
  let baseUrl;
  let workDir;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'lune-snap-route-'));
    const app = makeTestApp(path.join(workDir, 'uploads'), path.join(workDir, 'projects'));
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns 200 + project metadata for a valid v0.1.0 ZIP', async () => {
    const { zip } = buildLuneSnapshotZip();
    const form = new FormData();
    form.append('file', new Blob([zip], { type: 'application/zip' }), 'lune-frontend.od.zip');
    const res = await fetch(`${baseUrl}/api/import/lune-frontend-snapshot`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifestVersion).toBe('0.1.0');
    expect(body.project.name).toBe('Lune');
    expect(body.redirectUrl).toBe('/projects/test-project');
    expect(body.files).toContain('manifest.json');
  });

  it('returns 400 with manifestVersion 0.2.0', async () => {
    const { zip } = buildLuneSnapshotZip({
      manifest: { manifestVersion: '0.2.0', projectName: 'Lune' },
    });
    const form = new FormData();
    form.append('file', new Blob([zip], { type: 'application/zip' }), 'lune-frontend.od.zip');
    const res = await fetch(`${baseUrl}/api/import/lune-frontend-snapshot`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unsupported manifestVersion 0\.2\.0/);
  });

  it('returns 400 when file extension is not .zip', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('hi')], { type: 'text/plain' }), 'wrong.txt');
    const res = await fetch(`${baseUrl}/api/import/lune-frontend-snapshot`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/expected a \.zip file/);
  });

  it('returns 400 when no file is supplied', async () => {
    const res = await fetch(`${baseUrl}/api/import/lune-frontend-snapshot`, {
      method: 'POST',
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/zip file required/);
  });
});
