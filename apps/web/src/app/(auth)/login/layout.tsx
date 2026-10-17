import type { Metadata } from "next";

// The login page is a client component, so its metadata lives here. It is its own indexed page,
// separate from the landing page at `/`.
export const metadata: Metadata = {
  title: "Log in — Drafto",
  alternates: { canonical: "/login" },
  robots: { index: true, follow: true },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
