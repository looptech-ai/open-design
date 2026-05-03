// @ts-nocheck
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readZipEntries, safeJoin } from './zip-reader.js';

export async function importClaudeDesignZip(zipPath, projectDir) {
  const zip = await readFile(zipPath);
  const files = readZipEntries(zip);

  if (files.length === 0) throw new Error('zip contains no files');
  const entryFile = chooseEntryFile(files.map((f) => f.path));
  if (!entryFile) throw new Error('zip does not contain an HTML file');

  await mkdir(projectDir, { recursive: true });
  for (const f of files) {
    const target = safeJoin(projectDir, f.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.body);
  }

  return {
    entryFile,
    files: files.map((f) => f.path),
  };
}

function chooseEntryFile(paths) {
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
