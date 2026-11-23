import Link from "next/link";
import { cn } from "@/lib/cn";
import { LEGAL_PAGES } from "@/components/legal/legal-pages";

// The Privacy Policy and Support links on the signed-out pages. Google's OAuth brand
// verification needs the home page to link the privacy policy, and the store listings point
// reviewers at both pages.
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={cn("flex justify-center gap-4", className)}>
      {LEGAL_PAGES.map((page) => (
        <Link key={page.key} href={page.href} className="hover:text-fg hover:underline">
          {page.label}
        </Link>
      ))}
    </nav>
  );
}
