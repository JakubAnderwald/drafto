import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardBody } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Delete your account — Drafto",
  description:
    "How to permanently delete your Drafto account and data, with or without the app installed.",
};

function StepsCard({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardBody className="p-6">{children}</CardBody>
    </Card>
  );
}

export default function DeleteAccountInfoPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 sm:py-24">
      <header>
        <h1 className="text-fg text-4xl font-bold tracking-tight">Delete your account</h1>
        <p className="text-fg-muted mt-4 text-lg leading-8">
          You can permanently delete your Drafto account at any time, with or without the app
          installed.
        </p>
      </header>

      <div className="doc-prose mt-12">
        <section>
          <h2>Delete your account in the app</h2>
          <p>
            Deleting your account needs an internet connection. Before anything is deleted, you are
            asked to type <strong>DELETE</strong> to confirm. Deletion is immediate and permanent:
            it cannot be undone, and you are signed out straight away.
          </p>
          <p>
            Want to keep a copy of your notes? Export them from the web app before you delete your
            account.
          </p>

          <div className="mt-8 space-y-4">
            <StepsCard>
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
                  Type <strong>DELETE</strong> and select <strong>Delete account</strong> to
                  confirm.
                </li>
              </ol>
            </StepsCard>

            <StepsCard>
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
            </StepsCard>

            <StepsCard>
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
            </StepsCard>
          </div>
        </section>

        <section>
          <h2>What is deleted</h2>
          <ul>
            <li>Your account, including your email address and sign-in details</li>
            <li>All of your notebooks</li>
            <li>All of your notes, including notes in the trash and their edit history</li>
            <li>All of your attachments and uploaded files</li>
            <li>Your API keys</li>
          </ul>
        </section>

        <section>
          <h2>What may be kept</h2>
          <div>
            <p>
              Some data is held outside your account and is not deleted with it: error reports in
              Sentry and request logs at Vercel, which those services delete after their retention
              periods; emails we have exchanged with you, and notification emails our administrator
              received about your sign-up or support requests; and GitHub issues filed from your
              support emails. Ask us at support@drafto.eu to remove your support emails or issues.
              Our <Link href="/privacy">Privacy Policy</Link> describes each of these.
            </p>
            <p>
              Before you delete your account, sign out of Drafto on your other devices to erase
              their local copies; if you have already deleted it, uninstall the app there.
            </p>
          </div>
        </section>

        <section>
          <h2>No longer have the app, or can&apos;t sign in?</h2>
          <p>
            Email <a href="mailto:support@drafto.eu">support@drafto.eu</a> from the email address
            you signed up with and ask us to delete your account. We will confirm the request by
            replying to that address, and delete your account within 30 days.
          </p>
        </section>
      </div>

      <footer className="border-border-strong text-fg-muted mt-20 flex flex-wrap gap-x-6 gap-y-2 border-t pt-8 text-sm">
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
