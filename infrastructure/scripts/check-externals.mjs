#!/usr/bin/env node
/**
 * Every bare import surviving into a built bundle must be a declared dependency of that app.
 *
 * This bug has now shipped three times — `argon2`, `prisma`/`tsx`, and `nodemailer` — and
 * each time it looked different and cost an evening. The mechanism is always the same:
 *
 *   1. tsup has `noExternal: [/^@trip2world\//]`, so a workspace package's source is
 *      inlined into the app's own `dist/main.js`.
 *   2. A dependency of that workspace package — say `nodemailer`, which belongs to
 *      `@trip2world/mailer` — stays external, so the `import` survives into the bundle.
 *   3. That import is now in the APP's module graph, not the library's. pnpm's isolated
 *      `node_modules` means `apps/worker/node_modules/nodemailer` does not exist unless
 *      the app declares it, however many other packages depend on it.
 *   4. Everything builds. Everything typechecks. Tests pass, because they import from
 *      source rather than from `dist`. It fails only in the production container, at
 *      startup, as `ERR_MODULE_NOT_FOUND`.
 *
 * It cannot be caught by typechecking, by linting, or by any test that does not run the
 * built artifact in a pruned image. So it is caught here instead.
 *
 * **Reads the built output, not the tsup config.** The config states an intention; the
 * bundle is what will actually be executed. Checking the config would have missed an
 * import that became external for some other reason, and would have flagged `argon2` in
 * the worker — which was listed there and never imported at all.
 *
 * Run after `pnpm build`. Apps with no `dist` are skipped with a note, so a stale or
 * missing build is visible rather than passing silently.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appsDir = join(repoRoot, 'apps');

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/**
 * Bare package specifiers imported by a bundle.
 *
 * Covers static `import … from 'x'`, side-effect `import 'x'`, re-exports, and dynamic
 * `import('x')` — tsup emits all four. Relative and absolute specifiers resolve within
 * the bundle and cannot fail this way, so they are dropped.
 */
function bareImports(code) {
  const found = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      if (BUILTINS.has(specifier)) continue;

      // Reduce a deep import to its package name: `foo/bar` → `foo`, `@a/b/c` → `@a/b`.
      const parts = specifier.split('/');
      found.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  }

  return [...found].sort();
}

let failed = false;
let checked = 0;

const apps = readdirSync(appsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const app of apps) {
  const manifestPath = join(appsDir, app, 'package.json');
  const bundlePath = join(appsDir, app, 'dist', 'main.js');
  if (!existsSync(manifestPath)) continue;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // Next.js apps trace their own dependencies into a standalone output and do not
  // produce a dist/main.js. They fail differently and are not this bug's shape.
  if (!existsSync(bundlePath)) {
    console.log(`  ${app.padEnd(10)} no dist/main.js — skipped`);
    continue;
  }

  checked += 1;
  const imports = bareImports(readFileSync(bundlePath, 'utf8'));
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const missing = imports.filter((name) => !declared.has(name));

  if (missing.length === 0) {
    console.log(`  ${app.padEnd(10)} ${imports.length} runtime imports, all declared`);
  } else {
    failed = true;
    console.log(`  ${app.padEnd(10)} MISSING from dependencies:`);
    for (const name of missing) {
      console.log(`      ${name} — imported by the bundle, not a dependency of ${manifest.name}`);
    }
  }
}

console.log('');

if (checked === 0) {
  console.error('No built bundles found. Run `pnpm build` first, or this proves nothing.');
  process.exit(1);
}

if (failed) {
  console.error(
    'A production container will fail at startup with ERR_MODULE_NOT_FOUND.\n' +
      'Add each package above to that app\'s "dependencies", then run pnpm install.',
  );
  process.exit(1);
}

console.log('Every runtime import is a declared dependency.');
