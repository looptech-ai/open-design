// @ts-nocheck
//
// `/api/import/lune-frontend-snapshot` parser.
//
// Accepts a ZIP that conforms to the **lune-to-od-bridge v0.1.x manifest
// schema** — produced today by Lune's `pnpm export-to-od` (looptech-ai/lune
// `scripts/export-to-od.mjs`, contract `lune-to-od-bridge`) but specified
// generically so any frontend snapshotter can target it. The contract
// lives upstream at <https://github.com/looptech-ai/lune/blob/main/.claude/harness/contracts/lune-to-od-bridge.md>.
//
// ZIP contents (v0.1.x):
//   manifest.json         — top-level metadata + counts + file pointers
//   routes.json           — { routes: [{ path, file, group, dynamic, title }, ...] }
//   components.json       — { components: [{ name, file, props?, ... }, ...] }
//   design-tokens.json    — { cssVariables: { "--foo": "value", ... } }
//   screenshots/<file>    — optional PNG/JPEG static frames (one per route)
//   README.md             — human notes from the producer
//
// Per the contract's semver-major version gate, this importer accepts any
// `0.1.*` manifestVersion and rejects `0.2+` with an explicit "schema
// upgrade required" message. The version gate intentionally lives here
// (not in the producer) so OD can advertise its supported range without
// chasing every snapshotter's release cadence.

import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readZipEntries, safeJoin } from './zip-reader.js';

const SUPPORTED_MAJOR_MINOR = '0.1.';

const REQUIRED_FILES = ['manifest.json', 'routes.json', 'components.json', 'design-tokens.json'];

/**
 * Parse + persist a Lune-style frontend-snapshot ZIP.
 *
 * @param {string} zipPath — disk path to an uploaded ZIP
 * @param {string} projectDir — destination directory (created if absent)
 * @returns {Promise<{
 *   manifest: object,
 *   routes: object,
 *   components: object,
 *   designTokens: object,
 *   screenshots: { file: string }[],
 *   files: string[],
 * }>}
 *
 * Errors thrown here are user-facing (the route handler propagates the
 * `.message` verbatim into the 400 response body), so they MUST be
 * actionable: tell the operator what's wrong with the ZIP and what to
 * do next.
 */
export async function importLuneFrontendSnapshotZip(zipPath, projectDir) {
  const zip = await readFile(zipPath);
  const files = readZipEntries(zip);
  if (files.length === 0) throw new Error('zip contains no files');

  const byPath = new Map(files.map((f) => [f.path, f]));

  for (const required of REQUIRED_FILES) {
    if (!byPath.has(required)) {
      throw new Error(
        `lune-frontend-snapshot ZIP missing required file: ${required}. ` +
          `Expected v${SUPPORTED_MAJOR_MINOR}x layout (manifest.json + routes.json + components.json + design-tokens.json).`,
      );
    }
  }

  const manifest = parseJson(byPath.get('manifest.json').body, 'manifest.json');
  validateManifest(manifest);

  const routes = parseJson(byPath.get('routes.json').body, 'routes.json');
  const components = parseJson(byPath.get('components.json').body, 'components.json');
  const designTokens = parseJson(byPath.get('design-tokens.json').body, 'design-tokens.json');

  const screenshots = files
    .filter((f) => f.path.startsWith('screenshots/') && !f.path.endsWith('/.placeholder'))
    .map((f) => ({ file: f.path }));

  // Persist the raw artifact tree so OD's existing project-file viewers
  // (sidemap / token-set / static-frame loaders) can read them straight
  // off disk without any additional indirection. The same write loop the
  // claude-design import uses.
  await mkdir(projectDir, { recursive: true });
  for (const f of files) {
    const target = safeJoin(projectDir, f.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.body);
  }

  return {
    manifest,
    routes,
    components,
    designTokens,
    screenshots,
    files: files.map((f) => f.path),
  };
}

function parseJson(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
}

/**
 * Enforce the v0.1.x semver-major contract gate. Exported for direct
 * unit-testing of the version policy without going through the full
 * file-system-touching import path.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('manifest.json must be a JSON object');
  }
  const version = manifest.manifestVersion;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('manifest.json missing manifestVersion field');
  }
  if (!version.startsWith(SUPPORTED_MAJOR_MINOR)) {
    throw new Error(
      `unsupported manifestVersion ${version}: this OD build accepts ${SUPPORTED_MAJOR_MINOR}x. ` +
        `Re-export from the producer with a compatible bridge schema, ` +
        `or upgrade OD to a build that handles the newer schema.`,
    );
  }
  if (typeof manifest.projectName !== 'string' || !manifest.projectName.trim()) {
    throw new Error('manifest.json missing projectName field');
  }
}
