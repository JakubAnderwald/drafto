import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { outlineEntry, type OutlineEntry } from "@/components/legal/document-outline";
import { NumberedSection } from "@/components/legal/numbered-section";
import { TableOfContents } from "@/components/legal/table-of-contents";
import { Card, CardBody } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Privacy Policy — Drafto",
  description:
    "Drafto privacy policy. Learn what data we collect, who processes it, and your rights.",
};

const SECTIONS = [
  { id: "controller", title: "Who Is Responsible for Your Data" },
  { id: "data-we-collect", title: "Data We Collect" },
  { id: "how-we-use-your-data", title: "How We Use Your Data" },
  { id: "data-sharing", title: "Data Sharing" },
  { id: "connected-ai-assistants", title: "Connected AI Assistants (API Keys and MCP)" },
  { id: "international-transfers", title: "International Transfers" },
  { id: "storage-and-security", title: "Data Storage and Security" },
  { id: "your-rights", title: "Your Rights" },
  { id: "retention", title: "Data Retention" },
  { id: "children", title: "Children's Privacy" },
  { id: "changes", title: "Changes to This Policy" },
  { id: "contact", title: "Contact" },
] as const satisfies readonly OutlineEntry[];

type SectionId = (typeof SECTIONS)[number]["id"];

const section = (id: SectionId) => outlineEntry(SECTIONS, id);

function SectionLink({ id, children }: { id: SectionId; children: ReactNode }) {
  return <a href={`#${section(id).id}`}>{children}</a>;
}

function Callout({ children }: { children: ReactNode }) {
  return (
    <Card className="text-fg my-6">
      <CardBody className="px-6 py-5">{children}</CardBody>
    </Card>
  );
}

interface Processor {
  service: string;
  purpose: string;
  dataShared: string;
}

// `data-label` repeats the column name on each cell for the stacked phone layout in globals.css.
const PROCESSOR_COLUMNS = ["Service", "Purpose", "Data shared"] as const;

const PROCESSORS: readonly Processor[] = [
  {
    service: "Supabase",
    purpose: "Database, sign-in and file storage (EU, Ireland)",
    dataShared:
      "Account data, notes, attachments, note history, API key hashes; requests from your devices, including IP address",
  },
  {
    service: "Vercel",
    purpose: "Hosting for drafto.eu and its API",
    dataShared: "Web requests, including IP address, browser details and the data they carry",
  },
  {
    service: "Sentry",
    purpose:
      "Error tracking, performance monitoring and Session Replay (web app and drafto.eu servers only)",
    dataShared: "Error reports, page and request addresses, timings, masked session replays",
  },
  {
    service: "Resend",
    purpose: "Account emails: sign-up confirmation, password reset, approval",
    dataShared: "Your email address and the email's content",
  },
  {
    service: "Google",
    purpose: "Sign in with Google (optional); internet connection check in the iOS and macOS apps",
    dataShared:
      "Your sign-in, if you use it: Google shares your email address and basic profile. Connection check: your IP address and device details, no account or note data",
  },
  {
    service: "Apple",
    purpose: "Sign in with Apple (optional)",
    dataShared: "Your sign-in; Apple shares your email address and, if you choose, your name",
  },
  {
    service: "Zoho Mail",
    purpose: "Hosts the support@drafto.eu mailbox (EU data centre)",
    dataShared: "Emails you send us, with attachments",
  },
  {
    service: "Anthropic",
    purpose: "AI assistant (Claude) that sorts support email and writes replies",
    dataShared: "Support emails you send us, with headers and attachments",
  },
  {
    service: "GitHub",
    purpose: "Public issue tracker for bug reports and feature requests",
    dataShared:
      "Your report, which usually quotes your message; later replies on that thread; any attachments you sent; your email address (not shown on the issue page, but readable through GitHub's API)",
  },
];

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 sm:py-24">
      <header>
        <h1 className="text-fg text-4xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="text-fg-muted mt-3 text-sm">
          Effective date: March&nbsp;8,&nbsp;2026 &middot; Last updated: October&nbsp;8,&nbsp;2026
        </p>
        <p className="text-fg-muted mt-8 text-lg leading-8">
          Drafto (&ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;us&rdquo;) operates the Drafto apps
          for iOS, Android and macOS and the drafto.eu website (collectively, the
          &ldquo;Service&rdquo;). This Privacy Policy explains what data we collect, how we use it,
          who we share it with, and your rights.
        </p>
      </header>

      <div className="mt-12">
        <TableOfContents entries={SECTIONS} />
      </div>

      <div className="doc-prose mt-14">
        <NumberedSection {...section("controller")}>
          <p>The controller of your personal data is:</p>
          <Callout>
            <address>
              <strong>Jakub Anderwald</strong>
              <br />
              Warsaw, Poland
              <br />
              Email: <a href="mailto:support@drafto.eu">support@drafto.eu</a>
            </address>
          </Callout>
        </NumberedSection>

        <NumberedSection {...section("data-we-collect")}>
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
              <strong>Sign in with Google or Apple:</strong> no password is created, unless you
              later set one with &ldquo;Forgot password&rdquo;. We receive the details the provider
              shares with us. Google shares your email address and basic profile (name and profile
              picture link). Apple shares your email address, which can be a private relay address,
              and your name if you choose to share it (the iOS app discards the name and does not
              send it to us). Supabase keeps the details it receives with your account record;
              Drafto itself uses only your email address. Signing in with Google or Apple using the
              email address of an existing account links the two.
            </li>
          </ul>

          <h3>Account approval</h3>
          <p>
            Drafto is invite-only: new sign-ups are reviewed manually before the account is
            activated. When you sign up, our administrator receives an email with your email address
            and the time you signed up, and we email you once your account is approved. A sign-up
            that is not approved may be deleted.
          </p>

          <h3>Notes and content</h3>
          <p>
            Your notebooks, notes, and attachments are stored in our database and file storage
            (hosted by Supabase) so they can sync across your devices. Content is associated with
            your user account. When you edit a note, we keep the earlier versions of its content for
            30 days so they can be recovered after an accidental overwrite.
          </p>
          <p>
            Imports from Evernote (.enex) and TickTick (CSV) are processed from files you upload. We
            never connect to your Evernote or TickTick account.
          </p>

          <h3>Support emails</h3>
          <p>
            When you email <a href="mailto:support@drafto.eu">support@drafto.eu</a>, we receive your
            email address and name as they appear in your email, your message, its email headers,
            and any attachments.{" "}
            <SectionLink id="data-sharing">Section {section("data-sharing").number}</SectionLink>{" "}
            explains who processes support emails.
          </p>

          <h3>Device and usage data</h3>
          <h4>Error and performance monitoring on the web</h4>
          <p>
            When you use the web app at drafto.eu, we use Sentry to find and fix bugs. Sentry
            receives crash reports and error data, and performance data for every page load and
            request: the page and request addresses, timings, and your browser and device type.
            Request addresses can include what you type into search, and the file names and
            temporary links of attachments you view, which work for up to 7 days. Error reports can
            include your internal account ID and, if the email notifying us of your sign-up fails to
            send, your email address. Sentry is configured not to collect IP addresses.
          </p>

          <h4>Session Replay</h4>
          <p>
            The web app also uses Sentry Session Replay, which records about 10% of web sessions and
            every session in which an error occurs. A replay captures page layout, clicks, and the
            pages and requests you load. All text and form inputs are masked and images are blocked
            by default, but request addresses are recorded, and these can include search terms and
            temporary attachment links.
          </p>

          <h4>Analytics (not enabled)</h4>
          <p>
            The web app&apos;s code includes PostHog, a product-analytics tool, but it is not
            enabled: no PostHog key is configured, so nothing is sent to PostHog. We will update
            this policy before we turn on any analytics.
          </p>

          <h4>iOS, Android and macOS apps</h4>
          <p>
            The iOS, Android and macOS apps contain no analytics or crash-reporting SDK. They send
            no usage analytics or crash reports to Drafto. If our drafto.eu servers fail to handle a
            request from one of the apps (for example, an account deletion), the server may record
            that error in Sentry. Apple and Google may separately collect diagnostic data from your
            device, depending on your device settings and their own privacy policies.
          </p>
          <p>
            To check whether you are online, the iOS and macOS apps send a small request to a Google
            server (clients3.google.com) about once a minute while you are connected. Google
            receives your IP address and basic device details from that request, but no account or
            note data.
          </p>

          <h4>Hosting and database logs</h4>
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
            SQLite for offline access. This data stays on your device and syncs with our servers
            when you are online. Files you attach while offline stay on the device only until they
            upload.
          </p>
          <p>
            The local copy is erased when you sign out or delete your account in that app. Copies on
            your other devices stay until you sign out on them or uninstall the app. If a
            device&apos;s session ends on its own, for example because you deleted your account on
            another device, its copy stays until you uninstall the app or a different account signs
            in on it.
          </p>
        </NumberedSection>

        <NumberedSection {...section("how-we-use-your-data")}>
          <p>We use your data for these purposes, each with its legal basis under the GDPR:</p>
          <ul>
            <li>
              <strong>Provide the Service:</strong> store and sync your notes across devices, run
              your account, send essential account emails (sign-up confirmation, password reset,
              approval status), export your notes, and give AI assistants you connect access to your
              notes.{" "}
              <span className="mt-1 block text-sm">
                Legal basis: performance of our contract with you (Art. 6(1)(b)).
              </span>
            </li>
            <li>
              <strong>Review new sign-ups:</strong> keep Drafto invite-only and prevent abuse.{" "}
              <span className="mt-1 block text-sm">
                Legal basis: our legitimate interests (Art. 6(1)(f)).
              </span>
            </li>
            <li>
              <strong>Fix issues and keep the Service secure:</strong> error tracking, performance
              monitoring, Session Replay and hosting logs.{" "}
              <span className="mt-1 block text-sm">
                Legal basis: our legitimate interest in a reliable and secure Service (Art.
                6(1)(f)).
              </span>
            </li>
            <li>
              <strong>Provide support:</strong> answer your emails, with the help of an AI
              assistant, and track bug reports and feature requests.{" "}
              <span className="mt-1 block text-sm">
                Legal basis: our legitimate interest in answering you quickly and improving Drafto
                (Art. 6(1)(f)), or our contract with you when your request is about your account
                (Art. 6(1)(b)).
              </span>
            </li>
            <li>
              <strong>Meet legal obligations:</strong> for example, respond to requests to exercise
              your rights.{" "}
              <span className="mt-1 block text-sm">
                Legal basis: legal obligation (Art. 6(1)(c)).
              </span>
            </li>
          </ul>
          <p>
            You can object to processing based on our legitimate interests at any time (see{" "}
            <SectionLink id="your-rights">{section("your-rights").title}</SectionLink>).
          </p>
          <Callout>
            <p>
              We do <strong>not</strong> sell your data. We do <strong>not</strong> use your note
              content for advertising, training AI models, or any purpose other than providing the
              Service to you.
            </p>
          </Callout>
        </NumberedSection>

        <NumberedSection {...section("data-sharing")}>
          <p>
            We use the following third-party services to operate Drafto. Google and Apple process
            your sign-in under their own privacy policies, and only if you choose to sign in with
            them. Separately, the iOS and macOS apps contact a Google server to check your internet
            connection (see{" "}
            <SectionLink id="data-we-collect">
              Section {section("data-we-collect").number}
            </SectionLink>
            ).
          </p>
          <div className="bg-surface-lowest my-8 overflow-x-auto rounded-lg shadow-sm">
            {/* Explicit roles keep the table semantics when it stacks into cards on phones. */}
            <table role="table">
              <thead role="rowgroup">
                <tr role="row">
                  {PROCESSOR_COLUMNS.map((column) => (
                    <th key={column} role="columnheader">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup">
                {PROCESSORS.map(({ service, purpose, dataShared }) => (
                  <tr key={service} role="row">
                    <td role="cell" data-label={PROCESSOR_COLUMNS[0]}>
                      {service}
                    </td>
                    <td role="cell" data-label={PROCESSOR_COLUMNS[1]}>
                      {purpose}
                    </td>
                    <td role="cell" data-label={PROCESSOR_COLUMNS[2]}>
                      {dataShared}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>How we handle support emails</h3>
          <p>
            Zoho Mail stores messages to support@drafto.eu in its EU data centre. An AI assistant
            (Claude, made by Anthropic) reads each support email to sort it, answers many questions
            automatically, and drafts replies. Messages it cannot answer confidently go to a person.
            Requests to delete your account or to exercise your privacy rights are always handled by
            a person, and the assistant has no access to your notes or your account.
          </p>

          <h3>Bug reports and feature requests</h3>
          <p>
            If you report a bug or request a feature, we may file it as an issue in Drafto&apos;s
            public GitHub repository (github.com/JakubAnderwald/drafto), where anyone can read it.
            The issue usually quotes your message, and replies you later send on the same email
            thread are posted on the issue as comments.
          </p>
          <p>
            Any attachments you sent, including screenshots and other files, are uploaded to the
            same public repository and linked from the issue, and stay in its history even if the
            issue is later removed. Your email address is stored in hidden metadata on the issue: it
            is not shown on the issue page, but anyone can read it through GitHub&apos;s API.
          </p>
          <p>
            We do not share your data with any other third parties, except where the law requires
            it.
          </p>
        </NumberedSection>

        <NumberedSection {...section("connected-ai-assistants")}>
          <p>
            In Settings on drafto.eu you can create API keys that connect an AI assistant of your
            choice, such as Claude, to your notes through Drafto&apos;s MCP server at
            drafto.eu/api/mcp. This only happens at your direction. Drafto does not send your notes
            to any AI provider on its own.
          </p>
          <ul>
            <li>
              A key gives the assistant read and write access to all of your notebooks and notes. It
              can list, read and search them; create, edit, move and trash notes; and create, rename
              and delete notebooks. Deleting a notebook also permanently deletes any notes already
              in its trash.
            </li>
            <li>A key does not give access to your attachment files or your account details.</li>
            <li>
              What the assistant reads is processed by its provider, under your agreement with that
              provider and its privacy policy.
            </li>
            <li>
              Revoking a key in Settings stops it working immediately. Notes the assistant has
              already read stay with it.
            </li>
            <li>
              We store only a hash of each key, its first few characters, the name you give it, and
              when it was created, last used and revoked.
            </li>
          </ul>
        </NumberedSection>

        <NumberedSection {...section("international-transfers")}>
          <p>
            Your account data, notes and attachments are stored in the EU. Several of our providers
            are based in the United States or may process data there: Vercel, Sentry, Resend,
            Anthropic, GitHub, Google and Apple. Supabase is also a US company, although it stores
            our database in Ireland.
          </p>
          <p>
            When personal data is transferred outside the European Economic Area, we rely on the
            EU&ndash;US Data Privacy Framework for providers certified under it, and otherwise on
            the European Commission&apos;s Standard Contractual Clauses.
          </p>
        </NumberedSection>

        <NumberedSection {...section("storage-and-security")}>
          <ul>
            <li>
              Your account data, notes, attachments and note history are stored by Supabase in the
              EU (West EU, Ireland)
            </li>
            <li>
              Requests to drafto.eu are handled by Vercel, whose servers may be outside the EU
            </li>
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
        </NumberedSection>

        <NumberedSection {...section("your-rights")}>
          <p>You have the right to:</p>
          <ul>
            <li>
              <strong>Access</strong> your data at any time through the Service, or ask us for a
              copy
            </li>
            <li>
              <strong>Export</strong> your notes and attachments in Evernote (.enex) format from the
              web app&apos;s menu. Each export can include up to 1,000 notes and 200 MB of
              attachments, so export a large account a few notebooks at a time, or ask us for a
              copy. Notes in the trash and earlier note versions are not included
            </li>
            <li>
              <strong>Delete</strong> your account and the data stored in it at any time from within
              the app on the web, iOS, Android or macOS. Deletion is immediate. Some data held
              outside your account is kept (see{" "}
              <SectionLink id="retention">{section("retention").title}</SectionLink>). See{" "}
              <Link href="/account/delete">how to delete your account</Link>. If your account has
              not been approved yet, email us to delete it
            </li>
            <li>
              <strong>Correct</strong> your information: edit your notes in the app, reset your
              password with &ldquo;Forgot password&rdquo;, and contact{" "}
              <a href="mailto:support@drafto.eu">support@drafto.eu</a> to change your email address
              or correct other account data
            </li>
            <li>
              <strong>Withdraw</strong> an AI assistant&apos;s access to your notes by revoking its
              API key in Settings
            </li>
          </ul>
          <p>
            For EU residents (GDPR): You additionally have the right to data portability, to
            restrict processing, to object to processing based on our legitimate interests, and to
            lodge a complaint with a supervisory authority: in Poland, the President of the Personal
            Data Protection Office (UODO), or the authority where you live.
          </p>
          <Callout>
            <p>
              To exercise a right, email <a href="mailto:support@drafto.eu">support@drafto.eu</a>{" "}
              from your account&apos;s email address. We will reply to that address to confirm it is
              you, and respond within one month.
            </p>
          </Callout>
        </NumberedSection>

        <NumberedSection {...section("retention")}>
          <p>Your data is retained as long as your account is active.</p>

          <h3>Notes and notebooks</h3>
          <ul>
            <li>
              Notes you move to the trash are permanently deleted from our servers automatically 30
              days later. You can also delete them yourself at any time from the Trash
              (&ldquo;Delete forever&rdquo; on the web, &ldquo;Delete&rdquo; in the iOS, Android and
              macOS apps)
            </li>
            <li>
              Deleting a notebook deletes it from our servers immediately, together with any notes
              in its trash
            </li>
            <li>
              On iPhone, iPad and Android, a note already synced to the device is not removed when
              it is deleted on our servers or on another device: it stays in that app until you
              delete it there or sign out
            </li>
            <li>
              Earlier versions of a note&apos;s content are deleted automatically after 30 days
            </li>
            <li>
              Attachment files of permanently deleted notes may stay in storage until you delete
              your account
            </li>
          </ul>

          <h3>Your account</h3>
          <ul>
            <li>
              When you delete your account in the app, we immediately delete your account,
              notebooks, notes, attachments and API keys, including note history
            </li>
            <li>
              If you ask us to delete your account by email, we process the request within 30 days
            </li>
            <li>
              Revoked API keys are kept (the hash, first few characters, name and dates described
              above) until you delete your account
            </li>
          </ul>

          <h3>Data held outside your account</h3>
          <ul>
            <li>
              Some data is held outside your account and is not deleted with it: error reports in
              Sentry and request logs at Vercel, which those services delete after their retention
              periods; emails we have exchanged with you, and notification emails our administrator
              received about your sign-up or support requests; and GitHub issues filed from your
              support emails. Ask us at <a href="mailto:support@drafto.eu">support@drafto.eu</a> to
              remove your support emails or issues
            </li>
            <li>
              Our support system deletes its run logs after 30 days. It keeps the drafts and notes
              it saved while handling your email, a record of which email address reported which
              issue (with that email&apos;s subject line and Zoho message reference, so our progress
              updates reply on the same thread), and the email addresses it has sent automatic
              replies to, until you ask us to remove them
            </li>
          </ul>
        </NumberedSection>

        <NumberedSection {...section("children")}>
          <p>
            Drafto is not intended for children under 13. We do not knowingly collect data from
            children under 13. If you believe a child has provided us data, contact us and we will
            delete it.
          </p>
        </NumberedSection>

        <NumberedSection {...section("changes")}>
          <p>
            We may update this Privacy Policy from time to time. We will notify you of material
            changes by posting the updated policy on this page and updating the &ldquo;Last
            updated&rdquo; date.
          </p>
        </NumberedSection>

        <NumberedSection {...section("contact")}>
          <p>
            If you have questions about this Privacy Policy or want to exercise your rights, contact
            us at:
          </p>
          <Callout>
            <p>
              <strong>Email:</strong> <a href="mailto:support@drafto.eu">support@drafto.eu</a>
              <br />
              <strong>Website:</strong> <a href="https://drafto.eu">https://drafto.eu</a>
            </p>
          </Callout>
        </NumberedSection>
      </div>

      <footer className="border-border-strong text-fg-muted mt-20 flex flex-wrap gap-x-6 gap-y-2 border-t pt-8 text-sm">
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
