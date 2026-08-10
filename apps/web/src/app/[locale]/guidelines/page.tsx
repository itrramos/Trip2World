import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal-page';

export const metadata: Metadata = { title: 'Community Guidelines' };

export default function GuidelinesPage() {
  return (
    <LegalPage
      title="Community Guidelines"
      updated="August 2026"
      summary="Trip2World only works if talking to a stranger feels safe. These rules are short, and they are enforced — by real people reviewing real reports."
    >

      <section>
        <h2>The rules</h2>

        <p>
          <strong className="text-foreground">Be 18 or over.</strong> There is no exception
          and no discretion here. If you believe the person you are talking to is a minor,
          end the conversation and report it — that report goes to the top of the queue
          ahead of everything else.
        </p>

        <p>
          <strong className="text-foreground">Keep your clothes on.</strong> No nudity and
          no sexual activity on camera. People come here to talk to strangers; exposing
          yourself to someone who did not ask is the fastest way to lose your account.
        </p>

        <p>
          <strong className="text-foreground">No harassment or hate.</strong> Insults,
          slurs, threats, and abuse aimed at who someone is — their race, religion,
          nationality, gender, sexuality, disability — are not tolerated.
        </p>

        <p>
          <strong className="text-foreground">No violence or threats.</strong> Including
          threats made as a joke. We cannot tell the difference and will not try.
        </p>

        <p>
          <strong className="text-foreground">Do not record or share other people.</strong>{' '}
          The person on the other side agreed to a live conversation, not to appearing in
          your video. Screenshotting or recording someone and posting it elsewhere is a
          serious violation.
        </p>

        <p>
          <strong className="text-foreground">No spam, scams or advertising.</strong>{' '}
          Including sending people to other platforms, asking for money, or pretending to be
          someone you are not.
        </p>

        <p>
          <strong className="text-foreground">Tips are gifts, not payment for acts.</strong>{' '}
          Using tokens to solicit sexual content, or offering sexual content for tokens, is
          prohibited and will end your account.
        </p>
      </section>

      <section>
        <h2>Tipping and the extra-time offer</h2>
        <p>
          When someone tips you they may also offer to keep the conversation going. That is
          an offer, and declining is free:
        </p>
        <ul>
          <li>The tokens are yours whether you accept or decline.</li>
          <li>
            <strong className="text-foreground">
              Next, Report and Block never stop working.
            </strong>{' '}
            No amount of tokens can keep you in a conversation you want to leave.
          </li>
          <li>
            Nobody is entitled to anything in exchange for a tip. If someone tips you and
            then demands something, report them.
          </li>
        </ul>
      </section>

      <section>
        <h2>What happens when you are reported</h2>
        <p>
          Reports are reviewed by a person, not an automated filter. Depending on what
          happened and whether there is a pattern, the outcome is one of:
        </p>
        <ul>
          <li>Dismissed, if no rule was broken.</li>
          <li>A warning.</li>
          <li>A temporary suspension.</li>
          <li>A permanent ban.</li>
        </ul>
        <p>
          Reports about child safety and credible threats are reviewed before everything
          else regardless of when they arrived, and go straight to the most serious
          outcomes.
        </p>
      </section>

      <section>
        <h2>Reporting and blocking</h2>
        <p>
          The flag button in a conversation reports the other person and ends the call.
          Blocking is permanent and works both ways — you will not be matched with that
          person again.
        </p>
        <p>
          Report the behaviour, not the person you disagreed with. Deliberately false
          reports waste moderator time that other people need, and are themselves a
          violation.
        </p>
      </section>
    </LegalPage>
  );
}
