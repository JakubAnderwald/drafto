import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Delete your account — Drafto",
  description:
    "How to permanently delete your Drafto account and data, with or without the app installed.",
};

export default function DeleteAccountInfoPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-fg mb-2 text-3xl font-bold">Delete your account</h1>
      <p className="text-fg-muted mb-8">
        You can permanently delete your Drafto account at any time, with or without the app
        installed.
      </p>

      <div className="prose dark:prose-invert max-w-none">
        <h2>Delete your account in the app</h2>
        <p>
          Deleting your account needs an internet connection. Before anything is deleted, you are
          asked to type <strong>DELETE</strong> to confirm. Deletion is immediate and permanent: it
          cannot be undone, and you are signed out straight away.
        </p>
        <p>
          Want to keep a copy of your notes? Export them from the web app before you delete your
          account.
        </p>

        <h3>Web (drafto.eu)</h3>
        <ol>
          <li>
            Sign in at <a href="https://drafto.eu">drafto.eu</a>.
          </li>
          <li>
            Open the app menu and choose <strong>Settings</strong>.
          </li>
          <li>
            Under <strong>Delete account</strong>, select <strong>Delete account</strong>.
          </li>
          <li>
            Type <strong>DELETE</strong> and select <strong>Delete account</strong> to confirm.
          </li>
        </ol>

        <h3>iPhone, iPad and Android</h3>
        <ol>
          <li>Open the Drafto app and sign in.</li>
          <li>
            Go to the <strong>Settings</strong> tab.
          </li>
          <li>
            Tap <strong>Delete account</strong>.
          </li>
          <li>
            Type <strong>DELETE</strong> and tap <strong>Delete account</strong> to confirm.
          </li>
        </ol>

        <h3>Mac</h3>
        <ol>
          <li>Open the Drafto app and sign in.</li>
          <li>
            At the bottom of the sidebar, click the <strong>⋯</strong> menu next to your email
            address.
          </li>
          <li>
            Choose <strong>Delete account</strong>.
          </li>
          <li>
            Type <strong>DELETE</strong> and click <strong>Delete account</strong> to confirm.
          </li>
        </ol>

        <h2>What is deleted</h2>
        <ul>
          <li>Your account, including your email address and sign-in details</li>
          <li>All of your notebooks</li>
          <li>All of your notes, including notes in the trash and their edit history</li>
          <li>All of your attachments and uploaded files</li>
          <li>Your API keys</li>
        </ul>

        <h2>What may be kept</h2>
        <p>
          Anonymous usage analytics from the web app may be retained in aggregate form, as described
          in our <Link href="/privacy">Privacy Policy</Link>. This data does not include note
          content. The iOS, Android and macOS apps send no usage analytics.
        </p>

        <h2>No longer have the app, or can&apos;t sign in?</h2>
        <p>
          Email <a href="mailto:support@drafto.eu">support@drafto.eu</a> from the email address you
          signed up with and ask us to delete your account. We will confirm the request by replying
          to that address, and delete your account within 30 days.
        </p>
      </div>

      <footer className="border-border text-fg-muted mt-12 flex flex-wrap gap-x-6 gap-y-2 border-t pt-6 text-sm">
        <Link href="/privacy" className="hover:text-fg hover:underline">
          Privacy Policy
        </Link>
        <Link href="/support" className="hover:text-fg hover:underline">
          Support
        </Link>
      </footer>
    </main>
  );
}
