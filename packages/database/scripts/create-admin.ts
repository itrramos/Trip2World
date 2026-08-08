/**
 * First-admin bootstrap: `pnpm admin:create`
 *
 * There is deliberately no seeded default administrator and no default password anywhere
 * in this repository or in the Docker images — a well-known admin credential on a
 * publicly reachable deployment is the single most reliable way to lose a server.
 *
 * The operator runs this once, interactively, against the live database. Passwords are
 * read with echo suppressed, checked against the same policy the API enforces, and hashed
 * with Argon2id before anything is written.
 *
 * Non-interactive use (CI, automated provisioning) is supported via environment variables
 * so the password never appears in shell history or the process list:
 *
 *   ADMIN_EMAIL=… ADMIN_USERNAME=… ADMIN_PASSWORD=… pnpm admin:create --non-interactive
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Matches the API's Argon2id parameters — see packages/auth/src/password.ts. */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_]{1,22}[a-z0-9])?$/;
const MIN_PASSWORD_LENGTH = 10;

/**
 * Control codes handled while reading a password in raw mode.
 * Compared numerically rather than as literal characters so this file contains no
 * unprintable bytes — those are invisible in review and break naive text tooling.
 */
const KEY = {
  ETX: 3, // Ctrl-C
  EOT: 4, // Ctrl-D
  BACKSPACE: 8,
  LINE_FEED: 10,
  CARRIAGE_RETURN: 13,
  DELETE: 127,
  FIRST_PRINTABLE: 32,
} as const;

function fail(message: string): never {
  process.stderr.write(`\n  x ${message}\n\n`);
  process.exit(1);
}

/** Read a line with terminal echo disabled so the password never appears on screen. */
async function readSecret(prompt: string): Promise<string> {
  stdout.write(prompt);

  if (!stdin.isTTY) {
    // No TTY (piped input): fall back to a plain read rather than failing outright.
    const rl = createInterface({ input: stdin, output: stdout, terminal: false });
    const line = await rl.question('');
    rl.close();
    return line;
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve) => {
    let value = '';

    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        const code = char.codePointAt(0) ?? 0;

        if (code === KEY.LINE_FEED || code === KEY.CARRIAGE_RETURN || code === KEY.EOT) {
          finish();
          return;
        }
        if (code === KEY.ETX) {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (code === KEY.BACKSPACE || code === KEY.DELETE) {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore every other control character; accept anything printable.
        if (code >= KEY.FIRST_PRINTABLE) value += char;
      }
    };

    stdin.on('data', onData);
  });
}

function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 128) return 'Password must be at most 128 characters.';
  if (new Set(password).size < 4) return 'Password is too repetitive.';
  return null;
}

async function main() {
  const nonInteractive = process.argv.includes('--non-interactive');

  process.stdout.write('\n  Trip2World - create administrator\n');
  process.stdout.write('  ---------------------------------\n\n');

  let email: string;
  let username: string;
  let displayName: string;
  let password: string;

  if (nonInteractive) {
    email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
    username = (process.env.ADMIN_USERNAME ?? '').trim().toLowerCase();
    displayName = (process.env.ADMIN_DISPLAY_NAME ?? '').trim() || username;
    password = process.env.ADMIN_PASSWORD ?? '';

    if (!email || !username || !password) {
      fail('ADMIN_EMAIL, ADMIN_USERNAME and ADMIN_PASSWORD must all be set.');
    }
  } else {
    const rl = createInterface({ input: stdin, output: stdout });

    email = (await rl.question('  Email:          ')).trim().toLowerCase();
    username = (await rl.question('  Username:       ')).trim().toLowerCase();
    displayName = (await rl.question('  Display name:   ')).trim();
    rl.close();

    password = await readSecret('  Password:       ');
    const confirm = await readSecret('  Confirm:        ');
    if (password !== confirm) fail('Passwords do not match.');
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('That is not a valid email address.');
  if (!USERNAME_PATTERN.test(username)) {
    fail('Username must be 3-24 lowercase letters, numbers or underscores.');
  }
  const passwordProblem = validatePassword(password);
  if (passwordProblem) fail(passwordProblem);

  if (!displayName) displayName = username;

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
    select: { id: true, email: true, username: true, role: true },
  });

  if (existing) {
    // Promoting an existing account is a legitimate recovery path, but it must be an
    // explicit decision rather than a silent side effect of re-running the command.
    if (nonInteractive) {
      fail(
        `An account already exists with that ${existing.email === email ? 'email' : 'username'}. ` +
          'Refusing to modify it in non-interactive mode.',
      );
    }

    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (
      await rl.question(
        `\n  An account already exists (${existing.username}, role ${existing.role}).\n` +
          '  Promote it to SUPER_ADMIN and reset its password? [y/N] ',
      )
    )
      .trim()
      .toLowerCase();
    rl.close();

    if (answer !== 'y' && answer !== 'yes') fail('Aborted. No changes were made.');

    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        role: 'SUPER_ADMIN',
        passwordHash,
        status: 'ACTIVE',
        emailVerified: true,
        emailVerifiedAt: new Date(),
        // Invalidate every previously issued token for this account.
        tokenGeneration: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    await prisma.session.updateMany({
      where: { userId: existing.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'admin-bootstrap' },
    });
    await prisma.auditLog.create({
      data: {
        actorId: existing.id,
        actorType: 'SYSTEM',
        action: 'admin.bootstrap.promote',
        targetType: 'User',
        targetId: existing.id,
        metadata: { username: existing.username },
      },
    });

    process.stdout.write(`\n  OK - ${existing.username} promoted to SUPER_ADMIN.\n\n`);
    return;
  }

  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

  // Date of birth is required by the schema. An administrator account is not a
  // matchmaking participant, so a fixed sentinel well above the age gate is used rather
  // than prompting for a personal detail the role does not need.
  const birthDate = new Date('1970-01-01T00:00:00.000Z');

  const user = await prisma.user.create({
    data: {
      email,
      username,
      passwordHash,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      profile: { create: { displayName, birthDate, gender: 'UNSPECIFIED', locale: 'en' } },
      privacy: { create: {} },
      preference: { create: {} },
    },
    select: { id: true, username: true, email: true },
  });

  await prisma.auditLog.create({
    data: {
      actorId: user.id,
      actorType: 'SYSTEM',
      action: 'admin.bootstrap.create',
      targetType: 'User',
      targetId: user.id,
      metadata: { username: user.username },
    },
  });

  process.stdout.write(`\n  OK - administrator "${user.username}" created.\n`);
  process.stdout.write('  Sign in at the admin panel with the credentials you just set.\n\n');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`\n  x ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
