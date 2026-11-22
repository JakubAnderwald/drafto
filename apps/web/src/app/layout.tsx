import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { ThemeSync } from "@/components/layout/theme-sync";
import { PostHogProvider } from "@/lib/posthog/provider";
import { NONCE_HEADER } from "@/lib/security/content-security-policy";
import { SITE_URL } from "@/lib/site";
import { buildThemeBootstrapScript } from "@/lib/theme/theme-chrome";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Resolves the relative `alternates.canonical` paths that pages declare.
  metadataBase: new URL(SITE_URL),
  title: "Drafto",
  description: "Your notes, organized.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The per-request nonce `middleware.ts` forwards (ADR-0069). The CSP blocks an inline script
  // without it. Reading headers renders every page per request: a page prerendered at build
  // time would have no nonce on its scripts.
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets the `dark` class and adds the `theme-color` meta before first paint (#865). */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: buildThemeBootstrapScript() }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ThemeSync />
        <PostHogProvider>{children}</PostHogProvider>
      </body>
    </html>
  );
}
