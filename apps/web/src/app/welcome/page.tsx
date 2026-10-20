import type { Metadata } from "next";
import { FeatureList } from "@/components/landing/feature-list";
import { LandingHero } from "@/components/landing/landing-hero";
import { LegalLinks } from "@/components/legal/legal-links";
import { ThemeToggle } from "@/components/ui/theme-toggle";

// The public home page. Middleware rewrites signed-out `/` here and sends direct visits to
// /welcome back to `/`, so this page only ever answers at `/`, which is its canonical URL.
export const metadata: Metadata = {
  title: "Drafto — notes for the web, iPhone, iPad, Android and Mac",
  description:
    "Drafto is a note-taking app for the web, iPhone, iPad, Android and Mac: notebooks, a rich-text editor, search, offline apps and Evernote import.",
  alternates: { canonical: "/" },
};

export default function WelcomePage() {
  return (
    <div className="brand-backdrop relative flex min-h-screen flex-col">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-20 sm:py-28">
        <LandingHero />
        <FeatureList />
      </main>
      <footer className="text-fg-muted px-6 pb-10 text-center text-sm">
        <LegalLinks />
      </footer>
    </div>
  );
}
