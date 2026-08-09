import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/legal-page';

export const metadata: Metadata = { title: 'Staying safe' };

/**
 * Practical advice rather than policy. The Guidelines say what we enforce; this says what
 * a user can do for themselves, which is the part that actually protects them in the
 * moment.
 */
export default function SafetyPage() {
  return (
    <LegalPage
      title="Staying safe"
      updated="August 2026"
      summary="Talking to strangers is the point of Trip2World, and it carries real risks. Here is what the app does for you, and what is worth doing for yourself."
    >
      <section>
        <h2>You can always leave</h2>
        <p>
          <strong className="text-foreground">Next</strong> ends the conversation
          immediately. You never owe anyone an explanation, and you do not need a reason.
        </p>
        <p>
          Nothing can disable it — not a tip, not an offer of extra time, not anything
          someone says. If a person tries to convince you that you have to stay, that is
          itself a reason to leave and report them.
        </p>
      </section>

      <section>
        <h2>Protect your identity</h2>
        <ul>
          <li>
            Do not share your full name, address, workplace, school, phone number or email.
          </li>
          <li>
            Be careful what is visible behind you. Street signs, house numbers, post, and
            distinctive views all give away where you live.
          </li>
          <li>
            Be wary of moving to another platform. Much of the harm we see starts with
            &ldquo;add me on…&rdquo;.
          </li>
          <li>
            Trip2World shows other people your country — never your city or precise
            location. Do not fill that gap in yourself.
          </li>
        </ul>
      </section>

      <section>
        <h2>Recognise the common manipulations</h2>
        <ul>
          <li>
            <strong className="text-foreground">Urgency.</strong> Pressure to act fast, or
            to decide something before you have thought about it.
          </li>
          <li>
            <strong className="text-foreground">Money.</strong> Anyone asking for money,
            gift cards, or crypto is running a scam. Without exception.
          </li>
          <li>
            <strong className="text-foreground">Reciprocity.</strong> Someone doing you a
            favour — including sending tokens — then implying you owe them something.
          </li>
          <li>
            <strong className="text-foreground">Images as leverage.</strong> Never send
            intimate photos or video. Sextortion typically starts with a friendly request
            and turns to threats immediately afterwards.
          </li>
        </ul>
      </section>

      <section>
        <h2>If someone threatens you</h2>
        <p>
          Blackmail over images is a crime, and you are the victim of it. Do not pay — it
          almost never stops. Block them, report them here, and report it to your local
          police. Many countries have a dedicated cybercrime or online-harm reporting line.
        </p>
        <p>
          If someone is in immediate danger, contact your local emergency services first.
        </p>
      </section>

      <section>
        <h2>If you think someone is under 18</h2>
        <p>
          End the conversation and report it with the{' '}
          <strong className="text-foreground">underage</strong> category. Those reports are
          reviewed before everything else in the queue, regardless of when they arrived.
        </p>
        <p>Please do not confront them, and do not keep talking to gather evidence.</p>
      </section>

      <section>
        <h2>Reporting and blocking</h2>
        <p>
          The flag button reports the other person and ends the call. Reports go to a human
          moderator, along with whether that account has been reported before — which is
          usually what turns a single complaint into action.
        </p>
        <p>
          Blocking is permanent and works in both directions. You will not be matched with
          that person again.
        </p>
        <p>
          Read the{' '}
          <Link href="/guidelines" className="text-brand underline underline-offset-4">
            Community Guidelines
          </Link>{' '}
          for what we act on and what happens next.
        </p>
      </section>
    </LegalPage>
  );
}
