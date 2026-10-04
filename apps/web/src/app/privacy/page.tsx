import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Drafto",
  description:
    "Drafto privacy policy. Learn what data we collect, who processes it, and your rights.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-fg mb-2 text-3xl font-bold">Privacy Policy</h1>
      <p className="text-fg-muted mb-8 text-sm">
        Effective date: March 8, 2026 &middot; Last updated: October 4, 2026
      </p>

      <div className="prose dark:prose-invert max-w-none">
        <p>
          Drafto (&ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;us&rdquo;) operates the Drafto apps
          for iOS, Android and macOS and the drafto.eu website (collectively, the
          &ldquo;Service&rdquo;). This Privacy Policy explains what data we collect, how we use it,
          who we share it with, and your rights.
        </p>

        <h2>1. Who Is Responsible for Your Data</h2>
        <p>The controller of your personal data is:</p>
        <p>
          <strong>Jakub Anderwald</strong>
          <br />
          Warsaw, Poland
          <br />
          Email: <a href="mailto:support@drafto.eu">support@drafto.eu</a>
        </p>

        <h2>2. Data We Collect</h2>

        <h3>Account data</h3>
        <p>
          You create an account with an email address and password, or with Google or Apple. We
          store your <strong>email address</strong>, when you signed up, and whether your account
          has been approved.
        </p>
        <ul>
          <li>
            <strong>Email and password:</strong> your password is handled by our authentication
            provider, Supabase, which stores only a <strong>hashed password</strong>. We do not
            store plain-text passwords.
          </li>
          <li>
            <strong>Sign in with Google or Apple:</strong> no password is created, unless you later
            set one with &ldquo;Forgot password&rdquo;. We receive the details the provider shares
            with us. Google shares your email address and basic profile (name and profile picture
            link). Apple shares your email address, which can be a private relay address, and your
            name if you choose to share it (the iOS app discards the name and does not send it to
            us). Supabase keeps the details it receives with your account record; Drafto itself uses
            only your email address. Signing in with Google or Apple using the email address of an
            existing account links the two.
          </li>
        </ul>

        <h3>Account approval</h3>
        <p>
          Drafto is invite-only: new sign-ups are reviewed manually before the account is activated.
          When you sign up, our administrator receives an email with your email address and the time
          you signed up, and we email you once your account is approved. A sign-up that is not
          approved may be deleted.
        </p>

        <h3>Notes and content</h3>
        <p>
          Your notebooks, notes, and attachments are stored in our database and file storage (hosted
          by Supabase) so they can sync across your devices. Content is associated with your user
          account. When you edit a note, we keep the earlier versions of its content for 30 days so
          they can be recovered after an accidental overwrite.
        </p>
        <p>
          Imports from Evernote (.enex) and TickTick (CSV) are processed from files you upload. We
          never connect to your Evernote or TickTick account.
        </p>

        <h3>Support emails</h3>
        <p>
          When you email <a href="mailto:support@drafto.eu">support@drafto.eu</a>, we receive your
          email address and name as they appear in your email, your message, its email headers, and
          any attachments. Section 4 explains who processes support emails.
        </p>

        <h3>Device and usage data</h3>
        <p>
          When you use the web app at drafto.eu, we use Sentry to find and fix bugs. Sentry receives
          crash reports and error data, and performance data for every page load and request: the
          page and request addresses, timings, and your browser and device type. Request addresses
          can include what you type into search, and the file names and temporary links of
          attachments you view, which work for up to 7 days. Error reports can include your internal
          account ID and, if the email notifying us of your sign-up fails to send, your email
          address. Sentry is configured not to collect IP addresses.
        </p>
        <p>
          The web app also uses Sentry Session Replay, which records about 10% of web sessions and
          every session in which an error occurs. A replay captures page layout, clicks, and the
          pages and requests you load. All text and form inputs are masked and images are blocked by
          default, but request addresses are recorded, and these can include search terms and
          temporary attachment links.
        </p>
        <p>
          The web app&apos;s code includes PostHog, a product-analytics tool, but it is not enabled:
          no PostHog key is configured, so nothing is sent to PostHog. We will update this policy
          before we turn on any analytics.
        </p>
        <p>
          The iOS, Android and macOS apps contain no analytics or crash-reporting SDK. They send no
          usage analytics or crash reports to Drafto. If our drafto.eu servers fail to handle a
          request from one of the apps (for example, an account deletion), the server may record
          that error in Sentry. Apple and Google may separately collect diagnostic data from your
          device, depending on your device settings and their own privacy policies.
        </p>
        <p>
          To check whether you are online, the iOS and macOS apps send a small request to a Google
          server (clients3.google.com) about once a minute while you are connected. Google receives
          your IP address and basic device details from that request, but no account or note data.
        </p>
        <p>
          Vercel, which hosts drafto.eu, processes every request to the website, including your IP
          address and browser details, and keeps request logs. Supabase, which runs our database,
          sign-in and file storage, receives the requests the apps and the web app send to it
          directly, including your IP address and device or browser details, and keeps request and
          sign-in logs.
        </p>

        <h3>Cookies and browser storage</h3>
        <p>
          The web app uses cookies only to keep you signed in. It also stores your light or dark
          theme choice in your browser, and Session Replay keeps a session marker in your
          browser&apos;s session storage. We use no advertising or analytics cookies.
        </p>

        <h3>Offline data</h3>
        <p>
          The iOS, Android and macOS apps store a local copy of your notes on your device using
          SQLite for offline access. This data stays on your device and syncs with our servers when
          you are online. Files you attach while offline stay on the device only until they upload.
          The local copy is erased when you sign out or delete your account in that app. Copies on
          your other devices stay until you sign out on them or uninstall the app. If a
          device&apos;s session ends on its own, for example because you deleted your account on
          another device, its copy stays until you uninstall the app or a different account signs in
          on it.
        </p>

        <h2>3. How We Use Your Data</h2>
        <p>We use your data for these purposes, each with its legal basis under the GDPR:</p>
        <ul>
          <li>
            <strong>Provide the Service:</strong> store and sync your notes across devices, run your
            account, send essential account emails (sign-up confirmation, password reset, approval
            status), export your notes, and give AI assistants you connect access to your notes.
            Legal basis: performance of our contract with you (Art. 6(1)(b)).
          </li>
          <li>
            <strong>Review new sign-ups:</strong> keep Drafto invite-only and prevent abuse. Legal
            basis: our legitimate interests (Art. 6(1)(f)).
          </li>
          <li>
            <strong>Fix issues and keep the Service secure:</strong> error tracking, performance
            monitoring, Session Replay and hosting logs. Legal basis: our legitimate interest in a
            reliable and secure Service (Art. 6(1)(f)).
          </li>
          <li>
            <strong>Provide support:</strong> answer your emails, with the help of an AI assistant,
            and track bug reports and feature requests. Legal basis: our legitimate interest in
            answering you quickly and improving Drafto (Art. 6(1)(f)), or our contract with you when
            your request is about your account (Art. 6(1)(b)).
          </li>
          <li>
            <strong>Meet legal obligations:</strong> for example, respond to requests to exercise
            your rights. Legal basis: legal obligation (Art. 6(1)(c)).
          </li>
        </ul>
        <p>
          You can object to processing based on our legitimate interests at any time (see Your
          Rights).
        </p>
        <p>
          We do <strong>not</strong> sell your data. We do <strong>not</strong> use your note
          content for advertising, training AI models, or any purpose other than providing the
          Service to you.
        </p>

        <h2>4. Data Sharing</h2>
        <p>
          We use the following third-party services to operate Drafto. Google and Apple process your
          sign-in under their own privacy policies, and only if you choose to sign in with them.
          Separately, the iOS and macOS apps contact a Google server to check your internet
          connection (see Section 2).
        </p>
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th>Purpose</th>
              <th>Data shared</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Supabase</td>
              <td>Database, sign-in and file storage (EU, Ireland)</td>
              <td>
                Account data, notes, attachments, note history, API key hashes; requests from your
                devices, including IP address
              </td>
            </tr>
            <tr>
              <td>Vercel</td>
              <td>Hosting for drafto.eu and its API</td>
              <td>Web requests, including IP address, browser details and the data they carry</td>
            </tr>
            <tr>
              <td>Sentry</td>
              <td>
                Error tracking, performance monitoring and Session Replay (web app and drafto.eu
                servers only)
              </td>
              <td>Error reports, page and request addresses, timings, masked session replays</td>
            </tr>
            <tr>
              <td>Resend</td>
              <td>Account emails: sign-up confirmation, password reset, approval</td>
              <td>Your email address and the email&apos;s content</td>
            </tr>
            <tr>
              <td>Google</td>
              <td>
                Sign in with Google (optional); internet connection check in the iOS and macOS apps
              </td>
              <td>
                Your sign-in, if you use it: Google shares your email address and basic profile.
                Connection check: your IP address and device details, no account or note data
              </td>
            </tr>
            <tr>
              <td>Apple</td>
              <td>Sign in with Apple (optional)</td>
              <td>Your sign-in; Apple shares your email address and, if you choose, your name</td>
            </tr>
            <tr>
              <td>Zoho Mail</td>
              <td>Hosts the support@drafto.eu mailbox (EU data centre)</td>
              <td>Emails you send us, with attachments</td>
            </tr>
            <tr>
              <td>Anthropic</td>
              <td>AI assistant (Claude) that sorts support email and writes replies</td>
              <td>Support emails you send us, with headers and attachments</td>
            </tr>
            <tr>
              <td>GitHub</td>
              <td>Public issue tracker for bug reports and feature requests</td>
              <td>
                Your report, which usually quotes your message; later replies on that thread; any
                attachments you sent; your email address (hidden)
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>Support emails.</strong> Zoho Mail stores messages to support@drafto.eu in its EU
          data centre. An AI assistant (Claude, made by Anthropic) reads each support email to sort
          it, answers many questions automatically, and drafts replies. Messages it cannot answer
          confidently go to a person. Requests to delete your account or to exercise your privacy
          rights are always handled by a person, and the assistant has no access to your notes or
          your account.
        </p>
        <p>
          If you report a bug or request a feature, we may file it as an issue in Drafto&apos;s
          public GitHub repository (github.com/JakubAnderwald/drafto), where anyone can read it. The
          issue usually quotes your message, and replies you later send on the same email thread are
          posted on the issue as comments. Any attachments you sent, including screenshots and other
          files, are uploaded to the same public repository and linked from the issue, and stay in
          its history even if the issue is later removed. Your email address is stored in hidden
          metadata on the issue: it is not shown on the issue page, but anyone can read it through
          GitHub&apos;s API.
        </p>
        <p>
          We do not share your data with any other third parties, except where the law requires it.
        </p>

        <h2>5. Connected AI Assistants (API Keys and MCP)</h2>
        <p>
          In Settings on drafto.eu you can create API keys that connect an AI assistant of your
          choice, such as Claude, to your notes through Drafto&apos;s MCP server at
          drafto.eu/api/mcp. This only happens at your direction. Drafto does not send your notes to
          any AI provider on its own.
        </p>
        <ul>
          <li>
            A key gives the assistant read and write access to all of your notebooks and notes. It
            can list, read and search them; create, edit, move and trash notes; and create, rename
            and delete notebooks. Deleting a notebook also permanently deletes any notes already in
            its trash.
          </li>
          <li>A key does not give access to your attachment files or your account details.</li>
          <li>
            What the assistant reads is processed by its provider, under your agreement with that
            provider and its privacy policy.
          </li>
          <li>
            Revoking a key in Settings stops it working immediately. Notes the assistant has already
            read stay with it.
          </li>
          <li>
            We store only a hash of each key, its first few characters, the name you give it, and
            when it was created, last used and revoked.
          </li>
        </ul>

        <h2>6. International Transfers</h2>
        <p>
          Your account data, notes and attachments are stored in the EU. Several of our providers
          are based in the United States or may process data there: Vercel, Sentry, Resend,
          Anthropic, GitHub, Google and Apple. Supabase is also a US company, although it stores our
          database in Ireland. When personal data is transferred outside the European Economic Area,
          we rely on the EU&ndash;US Data Privacy Framework for providers certified under it, and
          otherwise on the European Commission&apos;s Standard Contractual Clauses.
        </p>

        <h2>7. Data Storage and Security</h2>
        <ul>
          <li>
            Your account data, notes, attachments and note history are stored by Supabase in the EU
            (West EU, Ireland)
          </li>
          <li>Requests to drafto.eu are handled by Vercel, whose servers may be outside the EU</li>
          <li>All data is transmitted over HTTPS/TLS</li>
          <li>
            Attachments are kept in private storage and shown through temporary links that expire
            after 7 days. Anyone who has such a link can open the file until it expires
          </li>
          <li>
            Your sign-in session is kept in cookies on the web, in the iOS Keychain on iPhone and
            iPad, and encrypted with the Android Keystore on Android. The macOS app keeps it in
            app-sandboxed local storage (AsyncStorage) on your Mac, not in the macOS Keychain
          </li>
          <li>
            Access controls, including database row-level security, limit each account to its own
            notebooks, notes and attachments
          </li>
        </ul>

        <h2>8. Your Rights</h2>
        <p>You have the right to:</p>
        <ul>
          <li>
            <strong>Access</strong> your data at any time through the Service, or ask us for a copy
          </li>
          <li>
            <strong>Export</strong> your notes and attachments in Evernote (.enex) format from the
            web app&apos;s menu. Each export can include up to 1,000 notes and 200 MB of
            attachments, so export a large account a few notebooks at a time, or ask us for a copy.
            Notes in the trash and earlier note versions are not included
          </li>
          <li>
            <strong>Delete</strong> your account and all associated data at any time from within the
            app on the web, iOS, Android or macOS. Deletion is immediate. See{" "}
            <Link href="/account/delete">how to delete your account</Link>. If your account has not
            been approved yet, email us to delete it
          </li>
          <li>
            <strong>Correct</strong> your information: edit your notes in the app, reset your
            password with &ldquo;Forgot password&rdquo;, and contact support@drafto.eu to change
            your email address or correct other account data
          </li>
          <li>
            <strong>Withdraw</strong> an AI assistant&apos;s access to your notes by revoking its
            API key in Settings
          </li>
        </ul>
        <p>
          For EU residents (GDPR): You additionally have the right to data portability, to restrict
          processing, to object to processing based on our legitimate interests, and to lodge a
          complaint with a supervisory authority: in Poland, the President of the Personal Data
          Protection Office (UODO), or the authority where you live.
        </p>
        <p>
          To exercise a right, email support@drafto.eu from your account&apos;s email address. We
          will reply to that address to confirm it is you, and respond within one month.
        </p>

        <h2>9. Data Retention</h2>
        <ul>
          <li>Your data is retained as long as your account is active</li>
          <li>
            Notes you move to the trash are permanently deleted from our servers automatically 30
            days later. You can also delete them yourself at any time from the Trash (&ldquo;Delete
            forever&rdquo; on the web, &ldquo;Delete&rdquo; in the iOS, Android and macOS apps)
          </li>
          <li>
            Deleting a notebook deletes it from our servers immediately, together with any notes in
            its trash
          </li>
          <li>
            On iPhone, iPad and Android, a note already synced to the device is not removed when it
            is deleted on our servers or on another device: it stays in that app until you delete it
            there or sign out
          </li>
          <li>Earlier versions of a note&apos;s content are deleted automatically after 30 days</li>
          <li>
            Attachment files of permanently deleted notes may stay in storage until you delete your
            account
          </li>
          <li>
            When you delete your account in the app, we immediately delete your account, notebooks,
            notes, attachments and API keys, including note history
          </li>
          <li>
            If you ask us to delete your account by email, we process the request within 30 days
          </li>
          <li>
            Revoked API keys are kept (the hash, first few characters, name and dates described
            above) until you delete your account
          </li>
          <li>
            Some data is held outside your account and is not deleted with it: error reports in
            Sentry and request logs at Vercel, which those services delete after their retention
            periods; emails we have exchanged with you, and notification emails our administrator
            received about your sign-up or support requests; and GitHub issues filed from your
            support emails. Ask us at support@drafto.eu to remove your support emails or issues
          </li>
          <li>
            Our support system deletes its run logs after 30 days. Until we delete them, it keeps
            drafts and notes it saved while handling your email, a record of which email address
            reported which issue, and the email addresses it has sent automatic replies to
          </li>
        </ul>

        <h2>10. Children&apos;s Privacy</h2>
        <p>
          Drafto is not intended for children under 13. We do not knowingly collect data from
          children under 13. If you believe a child has provided us data, contact us and we will
          delete it.
        </p>

        <h2>11. Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. We will notify you of material
          changes by posting the updated policy on this page and updating the &ldquo;Last
          updated&rdquo; date.
        </p>

        <h2>12. Contact</h2>
        <p>
          If you have questions about this Privacy Policy or want to exercise your rights, contact
          us at:
        </p>
        <p>
          <strong>Email:</strong> <a href="mailto:support@drafto.eu">support@drafto.eu</a>
          <br />
          <strong>Website:</strong> <a href="https://drafto.eu">https://drafto.eu</a>
        </p>
      </div>

      <footer className="border-border text-fg-muted mt-12 flex flex-wrap gap-x-6 gap-y-2 border-t pt-6 text-sm">
        <Link href="/account/delete" className="hover:text-fg hover:underline">
          Delete your account
        </Link>
        <Link href="/support" className="hover:text-fg hover:underline">
          Support
        </Link>
      </footer>
    </main>
  );
}
