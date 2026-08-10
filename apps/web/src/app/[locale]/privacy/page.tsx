import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal-page';

export const metadata: Metadata = { title: 'Privacy' };

/**
 * Written against what the code actually does, not against a generic template. Every
 * claim here is traceable to an implementation detail:
 *   - country-only location: `toPublicProfile` in packages/shared/src/privacy.ts
 *   - age brackets: `ageBracketFor`, exact DOB never leaves the owner's own profile
 *   - no recording: Match stores metadata only; see the schema comment
 *   - hashed IPs: `hashIp` in packages/auth, salted and truncated
 *   - 14-day erasure: ACCOUNT_DELETION_GRACE_DAYS, executed by apps/worker
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      updated="August 2026"
      summary="Your conversations are never recorded. We store the minimum needed to run the service and to act on abuse reports — and country-level location is the most precise location data that exists anywhere in this system."
    >

      <section>
        <h2>What we collect</h2>
        <p>When you create an account:</p>
        <ul>
          <li>Email address — for sign-in, verification and password reset.</li>
          <li>Username and optional display name.</li>
          <li>
            Date of birth — used to confirm you are 18 or over. Other users never see it;
            they see only a broad age range such as “25–34”.
          </li>
          <li>Country. Never a city, an address, or GPS coordinates.</li>
          <li>Languages, interests and an optional short bio, if you choose to add them.</li>
        </ul>

        <p>Automatically, while you use the service:</p>
        <ul>
          <li>
            A salted, truncated hash of your IP address — never the address itself. It is
            deliberately short enough to collide, so it cannot identify a device, and it
            exists to detect abuse patterns such as mass registration.
          </li>
          <li>Which device or browser your sessions were created from.</li>
          <li>
            Metadata about conversations: who spoke to whom, when it started and ended,
            how it ended, and a connection-quality rating.
          </li>
        </ul>
      </section>

      <section>
        <h2>What we do not collect</h2>
        <p>
          <strong className="text-foreground">
            We do not record, store or listen to your video or audio.
          </strong>{' '}
          Conversations are peer-to-peer: the video and audio travel between the two
          participants, not through a server that keeps a copy. When a relay server is
          needed to get past a restrictive network, it passes encrypted traffic through
          without the ability to read it.
        </p>
        <p>
          Text messages sent during a conversation are relayed and not written to our
          database. They disappear when the conversation ends.
        </p>
        <p>
          We do not collect precise location, do not use advertising trackers, and do not
          sell data to anyone.
        </p>
      </section>

      <section>
        <h2>What other users can see</h2>
        <p>
          The person you are matched with sees only: your username, your display name and
          avatar if you set them, your country, an age range, your languages, your
          interests, and your bio. Each of those except the username can be hidden in your
          privacy settings.
        </p>
        <p>
          They never see your email, your exact age or date of birth, your IP address, or
          anything about your account history.
        </p>
      </section>

      <section>
        <h2>Why we keep conversation metadata</h2>
        <p>
          When someone reports another user, a moderator needs to know that the two people
          genuinely spoke, and when. Without that, reports cannot be verified and the
          report system stops protecting anyone.
        </p>
        <p>
          This metadata never includes what was said or shown — only that a conversation
          occurred.
        </p>
      </section>

      <section>
        <h2>Deleting your account</h2>
        <p>
          You can request deletion at any time from your settings. Your account is
          deactivated immediately and permanently erased after 14 days. Signing in during
          that period cancels the request.
        </p>
        <p>
          After erasure, your profile, email, sessions, blocks and connections are gone.
          Two things survive by design:
        </p>
        <ul>
          <li>
            Reports you filed <em>about other people</em> remain, with your identity
            removed. Otherwise anyone could report someone and then delete their account to
            erase the evidence.
          </li>
          <li>
            An anonymous record that a deletion happened, which is what lets us demonstrate
            the request was honoured.
          </li>
        </ul>
      </section>

      <section>
        <h2>Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access, correct, export or
          erase your personal data, and to object to certain processing. Most of this is
          available directly in your settings; for anything else, contact the operator of
          this deployment.
        </p>
      </section>

      <section>
        <h2>Third parties</h2>
        <ul>
          <li>Email delivery, so verification and password-reset messages reach you.</li>
          <li>
            A payment provider, if you buy tokens. They handle your card details — we never
            see or store them.
          </li>
        </ul>
      </section>
    </LegalPage>
  );
}
