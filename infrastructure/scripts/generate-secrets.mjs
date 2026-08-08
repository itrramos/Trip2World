#!/usr/bin/env node
/**
 * Fill every CHANGE_ME placeholder in .env with real entropy.
 *
 *   pnpm secrets:generate            # creates .env from .env.example if absent
 *   pnpm secrets:generate --force    # also rotates secrets that are already set
 *
 * Shipping a compose file with weak defaults is how self-hosted deployments get
 * compromised, so the application refuses to start on a CHANGE_ME value and this script
 * is the supported way to resolve that.
 *
 * Existing secrets are preserved by default: rotating JWT_SECRET logs every user out,
 * and rotating POSTGRES_PASSWORD without also changing it inside the database locks the
 * app out of its own data. Both are recoverable but neither should happen by accident.
 */

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const envPath = resolve(repoRoot, '.env');
const examplePath = resolve(repoRoot, '.env.example');

const force = process.argv.includes('--force');

/** base64url, no padding — safe in URLs, shell, YAML and connection strings alike. */
const secret = (bytes = 48) => randomBytes(bytes).toString('base64url');

/**
 * Passwords that end up inside a postgres:// URL must avoid characters that would need
 * percent-encoding, otherwise the connection string silently truncates at the wrong place.
 */
const alphanumeric = (length = 32) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
};

const GENERATORS = {
  JWT_SECRET: () => secret(48),
  SESSION_SECRET: () => secret(48),
  IP_HASH_SALT: () => secret(32),
  TURN_SECRET: () => secret(48),
  POSTGRES_PASSWORD: () => alphanumeric(32),
  REDIS_PASSWORD: () => alphanumeric(32),
};

function main() {
  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) {
      process.stderr.write('\n  x .env.example not found. Run this from the repository root.\n\n');
      process.exit(1);
    }
    copyFileSync(examplePath, envPath);
    process.stdout.write('\n  Created .env from .env.example\n');
  }

  let content = readFileSync(envPath, 'utf8');
  const generated = {};
  const skipped = [];

  for (const [key, generate] of Object.entries(GENERATORS)) {
    const pattern = new RegExp(`^(${key}=)(.*)$`, 'm');
    const match = content.match(pattern);
    if (!match) continue;

    const current = match[2].trim();
    const isPlaceholder = current === '' || current === 'CHANGE_ME';

    if (!isPlaceholder && !force) {
      skipped.push(key);
      continue;
    }

    const value = generate();
    generated[key] = value;
    content = content.replace(pattern, `$1${value}`);
  }

  // The connection strings embed the credentials, so they have to be rewritten in step
  // with them or the app would authenticate with a stale password.
  if (generated.POSTGRES_PASSWORD) {
    const user = (content.match(/^POSTGRES_USER=(.*)$/m)?.[1] ?? 'trip2world').trim();
    const db = (content.match(/^POSTGRES_DB=(.*)$/m)?.[1] ?? 'trip2world').trim();
    content = content.replace(
      /^DATABASE_URL=.*$/m,
      `DATABASE_URL=postgresql://${user}:${generated.POSTGRES_PASSWORD}@postgres:5432/${db}?schema=public`,
    );
  }

  if (generated.REDIS_PASSWORD) {
    content = content.replace(
      /^REDIS_URL=.*$/m,
      `REDIS_URL=redis://:${generated.REDIS_PASSWORD}@redis:6379`,
    );
  }

  writeFileSync(envPath, content, { mode: 0o600 });

  process.stdout.write('\n  Trip2World - secret generation\n');
  process.stdout.write('  ------------------------------\n');

  const generatedKeys = Object.keys(generated);
  if (generatedKeys.length > 0) {
    for (const key of generatedKeys) process.stdout.write(`  generated   ${key}\n`);
  }
  for (const key of skipped) process.stdout.write(`  kept        ${key} (already set)\n`);

  if (generatedKeys.length === 0) {
    process.stdout.write('\n  Nothing to do. Use --force to rotate existing secrets.\n');
  }

  process.stdout.write('\n  .env written with mode 0600.\n');
  process.stdout.write('  Remaining manual values: TURN_EXTERNAL_IP, SMTP_*, and the\n');
  process.stdout.write('  Cloudflare token for your chosen DEPLOY_MODE.\n\n');
}

main();
