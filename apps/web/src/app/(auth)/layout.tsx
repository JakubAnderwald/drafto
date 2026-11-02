import type { Metadata } from "next";
import { LegalLinks } from "@/components/legal/legal-links";
import { Card, CardBody } from "@/components/ui/card";
import { ThemeToggle } from "@/components/ui/theme-toggle";

// The utility pages in this group (password reset, waiting for approval, the desktop hand-off)
// are thin and near-identical, so they stay out of search results by default. So does /login
// (ADR-0059). /signup opts back in from its own layout.
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="brand-backdrop relative flex min-h-screen items-center justify-center px-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h2 className="brand-wordmark text-3xl font-bold tracking-tight">Drafto</h2>
          <p className="text-fg-muted mt-1 text-sm">Your notes, beautifully organized</p>
        </div>
        <Card shadow="lg">
          <CardBody className="px-8 py-6">{children}</CardBody>
        </Card>
        {/* Every auth page, indexed or not, also says what Drafto is and links the privacy
            policy: for visitors arriving from the landing page, and for Google OAuth brand
            verification. */}
        <footer className="text-fg-muted mt-6 text-center text-xs">
          <p>Drafto is a note-taking app for the web, iPhone, iPad, Android and Mac.</p>
          <LegalLinks className="mt-2" />
        </footer>
      </div>
    </div>
  );
}
