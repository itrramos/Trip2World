import { MailService, type MailLogger } from '@trip2world/mailer';
import type { AppConfig } from '../config.js';

/**
 * The implementation lives in `@trip2world/mailer` so the worker shares it — duplicating
 * SMTP handling means two places to get TLS negotiation and Gmail's quirks wrong.
 * This module only adapts the API's config shape to the mailer's.
 */
export function createMailService(config: AppConfig, logger: MailLogger): MailService {
  return new MailService(
    {
      transport: config.MAIL_TRANSPORT,
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      user: config.SMTP_USER,
      password: config.SMTP_PASSWORD,
      secure: config.SMTP_SECURE,
      from: config.MAIL_FROM,
      appUrl: config.APP_URL,
    },
    logger,
  );
}

export { MailService };
