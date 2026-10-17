import Link from "next/link";
import { buttonClassName } from "@/components/ui/button-styles";

export function LandingHero() {
  return (
    <header className="text-center">
      <h1 className="brand-wordmark text-5xl font-bold tracking-tight sm:text-6xl">Drafto</h1>
      <p className="text-fg mt-4 text-xl font-medium sm:text-2xl">
        Your notes, beautifully organized
      </p>
      <p className="text-fg-muted mx-auto mt-6 max-w-xl text-lg leading-8">
        Drafto is a note-taking app for the web, iPhone, iPad, Android and Mac. Write in notebooks,
        find any note in seconds, and pick up on any device where you left off.
      </p>
      <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link href="/signup" className={buttonClassName({ size: "lg", className: "w-40" })}>
          Sign up
        </Link>
        <Link
          href="/login"
          className={buttonClassName({ variant: "secondary", size: "lg", className: "w-40" })}
        >
          Log in
        </Link>
      </div>
      {/* Sign-up is gated by admin approval (docs/features/email-and-approval.md). */}
      <p className="text-fg-muted mt-4 text-sm">New accounts are reviewed and approved by hand.</p>
    </header>
  );
}
