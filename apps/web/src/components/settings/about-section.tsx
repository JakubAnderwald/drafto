import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

export interface AboutSectionProps {
  // Short commit SHA of the running build; the build line is left out when it's unknown.
  buildCommit?: string | null;
  className?: string;
}

const ABOUT_LINKS = [
  { href: "/privacy", label: "Privacy policy", testId: "about-privacy" },
  { href: "/support", label: "Support", testId: "about-support" },
] as const;

/**
 * The Settings page's last card (PrimeTestLab 11035 S-01): links to the privacy policy and the
 * support page, and which build is running. The links stay on the current origin, so a preview
 * links its own copy of the pages; mobile links drafto.eu (`PRIVACY_POLICY_URL`, `SUPPORT_URL`).
 */
export function AboutSection({ buildCommit, className }: Readonly<AboutSectionProps>) {
  return (
    <Card className={className} data-testid="about-section">
      <CardHeader>
        <h2 className="text-fg text-lg font-semibold">About</h2>
      </CardHeader>
      <CardBody>
        <ul className="flex flex-col gap-2 text-sm">
          {ABOUT_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="doc-link" data-testid={link.testId}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        {/* Which deployment is running, so a preview tester can match it to the commit under test */}
        {buildCommit && (
          <p data-testid="build-commit" className="text-fg-muted mt-4 font-mono text-xs">
            Build {buildCommit}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
