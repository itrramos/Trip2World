#!/usr/bin/env node
/**
 * Verify every translation against the English catalogue.
 *
 * Translations drift silently. Someone adds a key to `en.json` and the other catalogues
 * do not grow it; someone renames a key and the old one lingers in five files; someone
 * translates the placeholders inside a message, and `{name}` becomes `{nome}` — which
 * renders as the literal text `{nome}` to a real user, because ICU looks up the argument
 * by name.
 *
 * None of those break the build, and none of them are visible in an English-speaking
 * development environment. This is what catches them.
 *
 * Missing keys are a warning, not a failure: a catalogue is allowed to be partial,
 * because `src/i18n/request.ts` merges English underneath it key by key. Extra keys and
 * broken placeholders ARE failures — the first is dead weight that hides a rename, the
 * second is a bug the reader sees.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const messagesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'web',
  'messages',
);

const REFERENCE = 'en';

/** Flatten a nested catalogue to `a.b.c` → string. */
function flatten(tree, prefix = '') {
  const out = new Map();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      for (const [k, v] of flatten(value, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

/**
 * Argument names referenced by an ICU message.
 *
 * Deliberately loose: it takes the identifier at the start of each `{...}`, which covers
 * both plain `{name}` and the plural form `{count, plural, ...}` without pulling in a
 * full ICU parser. `#` inside a plural body is not an argument and is skipped.
 */
function placeholders(message) {
  const found = new Set();
  for (const match of message.matchAll(/\{\s*([A-Za-z0-9_]+)/g)) found.add(match[1]);
  return found;
}

/** XML-ish tags a message expects the caller to supply, e.g. `<link>…</link>`. */
function tags(message) {
  const found = new Set();
  for (const match of message.matchAll(/<([A-Za-z][A-Za-z0-9]*)>/g)) found.add(match[1]);
  return found;
}

const read = (locale) => {
  // Strip a UTF-8 BOM. `JSON.parse` rejects it, and editors on Windows add one without
  // being asked — this check found exactly that on its first run.
  const raw = readFileSync(join(messagesDir, `${locale}.json`), 'utf8').replace(/^﻿/, '');
  return flatten(JSON.parse(raw));
};

const reference = read(REFERENCE);
const locales = readdirSync(messagesDir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace(/\.json$/, ''))
  .filter((locale) => locale !== REFERENCE)
  .sort();

let failed = false;
console.log(`Reference: ${REFERENCE}.json — ${reference.size} keys\n`);

for (const locale of locales) {
  const catalogue = read(locale);
  const missing = [];
  const extra = [];
  const broken = [];

  for (const [key, value] of catalogue) {
    if (!reference.has(key)) {
      extra.push(key);
      continue;
    }

    const expectedArgs = placeholders(reference.get(key));
    const actualArgs = placeholders(value);
    for (const arg of expectedArgs) {
      if (!actualArgs.has(arg)) broken.push(`${key}: missing {${arg}}`);
    }
    for (const arg of actualArgs) {
      if (!expectedArgs.has(arg)) broken.push(`${key}: unknown {${arg}}`);
    }

    const expectedTags = tags(reference.get(key));
    for (const tag of expectedTags) {
      if (!tags(value).has(tag)) broken.push(`${key}: missing <${tag}> tag`);
    }
  }

  for (const key of reference.keys()) {
    if (!catalogue.has(key)) missing.push(key);
  }

  const translated = reference.size - missing.length;
  const percent = Math.round((translated / reference.size) * 100);

  if (extra.length === 0 && broken.length === 0) {
    console.log(`  ${locale}  ${percent}% translated (${translated}/${reference.size})`);
  } else {
    failed = true;
    console.log(`  ${locale}  ${percent}% translated — PROBLEMS`);
    for (const key of extra) console.log(`      extra key (not in ${REFERENCE}): ${key}`);
    for (const problem of broken) console.log(`      ${problem}`);
  }

  // Informational. A partial catalogue falls back to English key by key and is fine.
  if (missing.length > 0 && missing.length < reference.size) {
    console.log(`      ${missing.length} untranslated, falling back to ${REFERENCE}`);
  }
}

console.log('');
if (failed) {
  console.error('Message catalogues have problems. See above.');
  process.exit(1);
}
console.log('Message catalogues are consistent.');
