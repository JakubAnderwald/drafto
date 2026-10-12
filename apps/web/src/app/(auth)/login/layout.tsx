import type { Metadata } from "next";

// The login page is a client component, so its metadata lives here. Signed-out `/` redirects
// here with a 307, so without a canonical Google files /login as a duplicate of `/`.
export const metadata: Metadata = {
  title: "Log in — Drafto",
  alternates: { canonical: "/login" },
  robots: { index: true, follow: true },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
