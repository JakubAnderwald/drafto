import type { Metadata } from "next";

// The login page is a client component, so its metadata lives here. It keeps the auth group's
// `noindex, follow` and declares no canonical: the bare form is too thin to stand apart from the
// landing page, and Google kept folding it into `/` (ADR-0059).
export const metadata: Metadata = {
  title: "Log in — Drafto",
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
