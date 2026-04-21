import type { Metadata } from "next";

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
          To delete your account and all associated data, email{" "}
          <a href="mailto:privacy@drafto.eu">privacy@drafto.eu</a>. We will process your request
          within 30 days.
        </p>
      </div>
    </main>
  );
}
