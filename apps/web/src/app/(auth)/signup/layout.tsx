import type { Metadata } from "next";

// The sign-up page is a client component, so its metadata lives here.
export const metadata: Metadata = {
  title: "Sign up — Drafto",
  alternates: { canonical: "/signup" },
  robots: { index: true, follow: true },
};

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
