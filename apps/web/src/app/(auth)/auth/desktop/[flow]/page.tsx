import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DesktopHandoff } from "@/components/auth/desktop-handoff";
import { DESKTOP_FLOWS, isDesktopFlow } from "@/lib/auth/desktop-deep-link";

export const metadata: Metadata = {
  title: "Opening Drafto",
  robots: { index: false, follow: false },
};

// Only the two flows the macOS app routes on exist; anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return DESKTOP_FLOWS.map((flow) => ({ flow }));
}

/**
 * Where Supabase ends the macOS app's OAuth and password-reset redirects, so the
 * browser tab lands on a real page instead of freezing on a custom-scheme
 * redirect. The page forwards the result to the app; the (auth) layout supplies
 * the frame. See ADR-0044.
 */
export default async function DesktopHandoffPage({
  params,
}: {
  params: Promise<{ flow: string }>;
}) {
  const { flow } = await params;
  if (!isDesktopFlow(flow)) notFound();

  return <DesktopHandoff flow={flow} />;
}
