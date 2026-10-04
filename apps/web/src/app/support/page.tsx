import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Support — Drafto",
  description: "Get help with Drafto.",
};

export default function SupportPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 sm:py-24">
      <header>
        <h1 className="text-fg text-4xl font-bold tracking-tight">Support</h1>
        <p className="text-fg-muted mt-4 text-lg leading-8">
          Help with Drafto on the web, iPhone, iPad, Android and Mac.
        </p>
      </header>

      <Card className="mt-12">
        <CardBody className="p-6 sm:p-8">
          <h2 className="text-fg text-lg font-semibold">Contact us</h2>
          <p className="text-fg-muted mt-2">
            Questions, bug reports and feature requests are all welcome.
          </p>
          <p className="mt-4 text-lg font-medium">
            <a href="mailto:support@drafto.eu" className="doc-link">
              support@drafto.eu
            </a>
          </p>
          <p className="text-fg-muted mt-4 text-sm">
            An AI assistant helps us sort and answer support email. See the{" "}
            <Link href="/privacy" className="doc-link">
              Privacy Policy
            </Link>{" "}
            for how we handle your message.
          </p>
        </CardBody>
      </Card>

      <div className="doc-prose mt-16">
        <h2>Common questions</h2>

        <div className="divide-border-strong divide-y">
          <div className="py-8 first:pt-0 last:pb-0">
            <h3>How do I sync my notes between devices?</h3>
            <p>
              Notes sync automatically when you are connected to the internet. Sign in with the same
              account on the web app (drafto.eu) and the mobile app to keep everything in sync.
            </p>
          </div>

          <div className="py-8 first:pt-0 last:pb-0">
            <h3>Can I use Drafto offline?</h3>
            <p>
              Yes. The mobile app works fully offline. Any notes you create or edit while offline
              will sync automatically when you reconnect.
            </p>
          </div>

          <div className="py-8 first:pt-0 last:pb-0">
            <h3>How do I delete my account?</h3>
            <p>
              You can delete your account and all of your notebooks, notes and attachments from
              inside the app. Deletion is immediate and permanent, and needs an internet connection:
            </p>
            <ul>
              <li>
                <strong>Web:</strong> open <strong>Settings</strong> from the app menu and select{" "}
                <strong>Delete account</strong>.
              </li>
              <li>
                <strong>iPhone, iPad and Android:</strong> go to the <strong>Settings</strong> tab
                and tap <strong>Delete account</strong>.
              </li>
              <li>
                <strong>Mac:</strong> click the <strong>⋯</strong> menu at the bottom of the sidebar
                and choose <strong>Delete account</strong>.
              </li>
            </ul>
            <p>
              If you no longer have the app or can&apos;t sign in, email{" "}
              <a href="mailto:support@drafto.eu">support@drafto.eu</a> from the address you signed
              up with. We will confirm the request by replying to that address, and delete your
              account within 30 days. See{" "}
              <Link href="/account/delete">how to delete your account</Link> for what is deleted.
            </p>
          </div>
        </div>
      </div>

      <footer className="border-border-strong text-fg-muted mt-20 flex flex-wrap gap-x-6 gap-y-2 border-t pt-8 text-sm">
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
