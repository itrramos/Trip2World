import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Outbound email.
 *
 * Shared by the API (verification, password reset) and the worker (account-erasure
 * confirmations), because duplicating SMTP handling means two places to get TLS
 * negotiation and Gmail's quirks wrong.
 *
 * Configured for Gmail in the reference deployment. Three Gmail behaviours are worth
 * knowing, because each fails in a way that looks like something else:
 *
 *   - The password must be a 16-character App Password. Google removed plain-password
 *     SMTP, and the rejection surfaces as a generic auth failure.
 *   - `From` must match the authenticated account or a verified alias. Gmail silently
 *     rewrites anything else, breaking SPF/DKIM alignment and sending mail to spam — it
 *     is "delivered", just never seen.
 *   - Port 587 is STARTTLS (`secure: false`). Setting `secure: true` there produces a
 *     connection that hangs until timeout rather than a clear error.
 *
 * Sending is best-effort and never blocks the operation that triggered it: a registration
 * must not fail because Gmail is briefly rate limiting.
 */

export interface MailerConfig {
  transport: 'smtp' | 'log';
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
  from: string;
  /** Base URL used to build links in emails. */
  appUrl: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export class MailService {
  private transporter: Transporter | null = null;

  constructor(
    private readonly config: MailerConfig,
    private readonly logger: MailLogger,
  ) {}

  private getTransporter(): Transporter | null {
    if (this.config.transport === 'log' || !this.config.host) return null;
    if (this.transporter) return this.transporter;

    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      // false = STARTTLS (587), true = implicit TLS (465).
      secure: this.config.secure,
      auth: this.config.user
        ? { user: this.config.user, pass: this.config.password }
        : undefined,
      // Gmail throttles aggressively; reusing one connection for a burst is both faster
      // and less likely to trip its limits.
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      // Refuse to negotiate down to plaintext even if the server offers it.
      requireTLS: !this.config.secure,
      tls: { minVersion: 'TLSv1.2' },
    });

    return this.transporter;
  }

  async send(message: MailMessage): Promise<void> {
    const transporter = this.getTransporter();

    if (!transporter) {
      // Development: write it to the log so verification and reset can be exercised
      // without a mail provider. The production config validator refuses to let a live
      // deployment reach this branch.
      this.logger.info(
        { to: message.to, subject: message.subject, body: message.text },
        'MAIL (not sent — transport=log)',
      );
      return;
    }

    try {
      await transporter.sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
      this.logger.info({ to: message.to, subject: message.subject }, 'Mail sent');
    } catch (error) {
      // Log and swallow. The caller's operation already succeeded, and the user can
      // request another email. Throwing here would roll back a valid registration.
      this.logger.error({ err: error, to: message.to }, 'Failed to send mail');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Templates                                                           */
  /* ------------------------------------------------------------------ */

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const url = `${this.config.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
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
    const url = `${this.config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
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

  /**
   * Confirmation that an account has been erased.
   *
   * Sent by the worker after the deletion grace period. The address has to be captured
   * before the record is removed, which is why the worker reads it inside the same job
   * rather than looking it up afterwards.
   */
  async sendAccountDeletedEmail(to: string): Promise<void> {
    await this.send({
      to,
      subject: 'Your Trip2World account has been deleted',
      text: [
        'Your Trip2World account and personal data have been permanently deleted.',
        '',
        'Reports filed about other accounts are retained without any link to you, as they',
        'concern the safety of other people.',
        '',
        'You are welcome back any time — you would start with a fresh account.',
      ].join('\n'),
    });
  }

  /** Verify SMTP credentials at boot so a misconfiguration surfaces immediately. */
  async verifyConnection(): Promise<boolean> {
    const transporter = this.getTransporter();
    if (!transporter) return true;

    try {
      await transporter.verify();
      this.logger.info({}, 'SMTP connection verified');
      return true;
    } catch (error) {
      this.logger.error(
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
