import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('front-end panel parse gate', () => {
    it('extension/index.js is valid ESM (a top-level await or stray token kills the whole panel in the browser)', async () => {
        // Importing executes the module; its DOM access is guarded by try/catch
        // inside the module itself, so this is safe under Node.
        const mod = await import(pathToFileURL(path.join(repoRoot, 'extension', 'index.js')).href);
        assert.equal(typeof mod.initExtension, 'function');
    });

    it('extension/manifest.json parses and points at an existing entry file', async () => {
        const fs = await import('node:fs');
        const manifestPath = path.join(repoRoot, 'extension', 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assert.ok(manifest.version, 'manifest has a version');
        assert.ok(fs.existsSync(path.join(repoRoot, 'extension', manifest.js)), `entry ${manifest.js} exists`);
        if (manifest.css) {
            assert.ok(fs.existsSync(path.join(repoRoot, 'extension', manifest.css)), `stylesheet ${manifest.css} exists`);
        }
    });
});
