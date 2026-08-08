import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

/**
 * Outbound email.
 *
 * Configured for Gmail in the reference deployment. Three Gmail-specific behaviours are
 * worth knowing because each fails in a way that looks like something else:
 *
 *   - SMTP_PASSWORD must be a 16-character App Password. Google removed plain-password
 *     SMTP, and the rejection surfaces as a generic auth failure.
 *   - `From` must match the authenticated account or a verified alias. Gmail silently
 *     rewrites anything else, which breaks SPF/DKIM alignment and sends verification
 *     mail to spam — the message is "delivered", just never seen.
 *   - Port 587 is STARTTLS (`secure: false`). Setting `secure: true` there produces a
 *     connection that hangs until timeout rather than a clear error.
 *
 * Sending is best-effort and never blocks the request that triggered it: a registration
 * must not fail because Gmail is briefly rate limiting.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export class MailService {
  private transporter: Transporter | null = null;

  constructor(private readonly deps: { config: AppConfig; logger: Logger }) {}

  private getTransporter(): Transporter | null {
    const { config } = this.deps;

    if (config.MAIL_TRANSPORT === 'log' || !config.smtpConfigured) return null;
    if (this.transporter) return this.transporter;

    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      // false = STARTTLS (port 587), true = implicit TLS (port 465).
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
      // Gmail throttles aggressively; reusing one connection for a burst of sends is
      // both faster and less likely to trip its limits.
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      // Refuse to negotiate down to plaintext even if the server offers it.
      requireTLS: !config.SMTP_SECURE,
      tls: { minVersion: 'TLSv1.2' },
    });

    return this.transporter;
  }

  async send(message: MailMessage): Promise<void> {
    const { config, logger } = this.deps;
    const transporter = this.getTransporter();

    if (!transporter) {
      // Development: write it to the log so the verification and reset flows can be
      // exercised end to end without a mail provider. The production config validator
      // refuses to let this happen on a live deployment.
      logger.info(
        { to: message.to, subject: message.subject, body: message.text },
        'MAIL (not sent — MAIL_TRANSPORT=log)',
      );
      return;
    }

    try {
      await transporter.sendMail({
        from: config.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
      logger.info({ to: message.to, subject: message.subject }, 'Mail sent');
    } catch (error) {
      // Log and swallow. The caller's operation already succeeded; the user can request
      // another verification email. Throwing here would roll back a valid registration.
      logger.error({ err: error, to: message.to }, 'Failed to send mail');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Templates                                                           */
  /* ------------------------------------------------------------------ */

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const url = `${this.deps.config.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
    await this.send({
      to,
      subject: 'Confirm your email — Trip2World',
      text: [
        'Welcome to Trip2World.',
        '',
        'Confirm your email address to start meeting people:',
        url,
        '',
        'This link expires in 24 hours.',
        'If you did not create an account, you can ignore this message.',
      ].join('\n'),
    });
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const url = `${this.deps.config.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await this.send({
      to,
      subject: 'Reset your password — Trip2World',
      text: [
        'We received a request to reset your Trip2World password.',
        '',
        url,
        '',
        'This link expires in 1 hour and can only be used once.',
        'If you did not request this, you can ignore this message — your password has not changed.',
      ].join('\n'),
    });
  }

  /** Verify SMTP credentials at boot so a misconfiguration surfaces immediately. */
  async verifyConnection(): Promise<boolean> {
    const transporter = this.getTransporter();
    if (!transporter) return true;

    try {
      await transporter.verify();
      this.deps.logger.info('SMTP connection verified');
      return true;
    } catch (error) {
      this.deps.logger.error(
        { err: error },
        'SMTP verification failed — verification and password-reset email will not be delivered',
      );
      return false;
    }
  }

  async close(): Promise<void> {
    this.transporter?.close();
  }
}
