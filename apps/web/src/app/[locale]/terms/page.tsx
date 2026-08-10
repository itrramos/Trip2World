import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/legal-page';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="August 2026"
      summary="The agreement between you and the operator of this Trip2World deployment. In short: you must be 18 or over, follow the Community Guidelines, and understand that tokens are a digital product that cannot be cashed out."
    >

      <section>
        <h2>1. Who can use Trip2World</h2>
        <p>
          You must be at least 18 years old. By creating an account you confirm that you
          are, and that the date of birth you gave is accurate. Accounts found to belong to
          minors are removed without notice.
        </p>
        <p>
          You must not use the service if you have previously been banned, or if the law
          where you live prohibits it.
        </p>
      </section>

      <section>
        <h2>2. Your account</h2>
        <p>
          Keep your password to yourself and do not share your account. You are responsible
          for what happens under it. Tell the operator promptly if you think someone else
          has access.
        </p>
        <p>One person, one account. Creating accounts to evade a ban is a violation.</p>
      </section>

      <section>
        <h2>3. How you may behave</h2>
        <p>
          The{' '}
          <Link href="/guidelines" className="text-brand underline underline-offset-4">
            Community Guidelines
          </Link>{' '}
          form part of these Terms. Breaking them can result in a warning, suspension, or
          permanent ban, at the operator&rsquo;s discretion and depending on severity.
        </p>
        <p>You also agree not to:</p>
        <ul>
          <li>Record, screenshot or redistribute another user without their consent.</li>
          <li>Use bots, scripts or automation against the service.</li>
          <li>Attempt to break, overload, or gain unauthorised access to any part of it.</li>
          <li>Scrape or harvest information about other users.</li>
        </ul>
      </section>

      <section>
        <h2>4. Tokens</h2>
        <p>Tokens are a digital product used inside Trip2World. Specifically:</p>
        <ul>
          <li>
            Tokens have <strong className="text-foreground">no cash value</strong> and
            cannot be exchanged for money, withdrawn, or transferred outside the service.
          </li>
          <li>
            Tips are final. Once sent, a tip cannot be reversed or refunded, including when
            an accompanying offer of extra time is declined.
          </li>
          <li>
            Buying tokens is a purchase of a digital product delivered immediately. Where
            the law gives you a right to withdraw from a distance purchase, you are asked
            to waive it for the unused balance at the point of purchase; unused tokens may
            still be refundable at the operator&rsquo;s discretion.
          </li>
          <li>
            Tokens are not a payment for any act or service, and must not be solicited in
            exchange for one.
          </li>
          <li>
            If your account is terminated for breaking these Terms, any remaining token
            balance is forfeited.
          </li>
        </ul>
      </section>

      <section>
        <h2>5. Content and conduct of others</h2>
        <p>
          Trip2World connects you with strangers in real time. Conversations are not
          recorded or pre-screened, and the operator cannot review them before they happen.
          You may encounter people who behave badly.
        </p>
        <p>
          The tools to protect yourself are always available: <strong className="text-foreground">Next</strong>{' '}
          ends any conversation immediately, and <strong className="text-foreground">Report</strong>{' '}
          and <strong className="text-foreground">Block</strong> are never disabled for any
          reason.
        </p>
      </section>

      <section>
        <h2>6. Suspension and termination</h2>
        <p>
          The operator may suspend or terminate an account that breaks these Terms or the
          Community Guidelines, or where necessary to protect other users. Where practical
          you will be told the reason.
        </p>
        <p>
          You may delete your account at any time from your settings. See the{' '}
          <Link href="/privacy" className="text-brand underline underline-offset-4">
            Privacy page
          </Link>{' '}
          for exactly what is erased and what is retained.
        </p>
      </section>

      <section>
        <h2>7. Service availability</h2>
        <p>
          Trip2World is provided as-is. There is no guarantee of uninterrupted availability,
          and features may change or be withdrawn.
        </p>
      </section>

      <section>
        <h2>8. Changes to these Terms</h2>
        <p>
          These Terms may change. Material changes will be communicated before they take
          effect. Continuing to use the service after that means you accept them.
        </p>
      </section>
    </LegalPage>
  );
}
