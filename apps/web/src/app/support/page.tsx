import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Support — Drafto",
  description: "Get help with Drafto.",
};

export default function SupportPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-fg mb-2 text-3xl font-bold">Support</h1>
      <p className="text-fg-muted mb-8">Need help with Drafto? We&apos;re here for you.</p>

      <div className="prose dark:prose-invert max-w-none">
        <h2>Contact Us</h2>
        <p>
          For questions, bug reports, or feature requests, email us at{" "}
          <a href="mailto:support@drafto.eu">support@drafto.eu</a>.
        </p>

        <h2>Common Questions</h2>

        <h3>How do I sync my notes between devices?</h3>
        <p>
          Notes sync automatically when you are connected to the internet. Sign in with the same
          account on the web app (drafto.eu) and the mobile app to keep everything in sync.
        </p>

        <h3>Can I use Drafto offline?</h3>
        <p>
          Yes. The mobile app works fully offline. Any notes you create or edit while offline will
          sync automatically when you reconnect.
        </p>

        <h3>How do I delete my account?</h3>
        <p>
          You can delete your account and all of your notebooks, notes and attachments from inside
          the app. Deletion is immediate and permanent, and needs an internet connection:
        </p>
        <ul>
          <li>
            <strong>Web:</strong> open <strong>Settings</strong> from the app menu and select{" "}
            <strong>Delete account</strong>.
          </li>
          <li>
            <strong>iPhone, iPad and Android:</strong> go to the <strong>Settings</strong> tab and
            tap <strong>Delete account</strong>.
          </li>
          <li>
            <strong>Mac:</strong> in the sidebar, click <strong>Delete account</strong> next to{" "}
            <strong>Sign out</strong>.
          </li>
        </ul>
        <p>
          If you no longer have the app or can&apos;t sign in, email{" "}
          <a href="mailto:support@drafto.eu">support@drafto.eu</a> from the address you signed up
          with. We will confirm the request by replying to that address, and delete your account
          within 30 days. See <Link href="/account/delete">how to delete your account</Link> for
          what is deleted.
        </p>
      </div>

      <footer className="border-border text-fg-muted mt-12 flex flex-wrap gap-x-6 gap-y-2 border-t pt-6 text-sm">
        <Link href="/account/delete" className="hover:text-fg hover:underline">
          Delete your account
        </Link>
        <Link href="/privacy" className="hover:text-fg hover:underline">
          Privacy Policy
        </Link>
      </footer>
    </main>
  );
}
