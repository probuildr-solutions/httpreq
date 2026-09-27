// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The root package.json is the single source of the app's version: the web build reads it, and
 * the installer is stamped with it. Every workspace must carry the same number, so the desktop
 * app's own `app.getVersion()` in development agrees with what the renderer shows. Change it for
 * all of them at once with `npm run version:set -- <version>`.
 */
const root = fileURLToPath(new URL('../../..', import.meta.url));
const versionOf = (path: string) =>
  (JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { version: string }).version;

describe('application version', () => {
  it('is the same in every workspace', () => {
    const expected = versionOf(root);
    expect(expected).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    for (const group of ['apps', 'packages']) {
      for (const name of readdirSync(join(root, group))) {
        expect({
          workspace: `${group}/${name}`,
          version: versionOf(join(root, group, name)),
        }).toEqual({
          workspace: `${group}/${name}`,
          version: expected,
        });
      }
    }
  });
});
