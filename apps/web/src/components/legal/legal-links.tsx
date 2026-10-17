import Link from "next/link";
import { cn } from "@/lib/cn";

// The Privacy Policy and Support links on the signed-out pages. Google's OAuth brand
// verification needs the home page to link the privacy policy, and the store listings point
// reviewers at both pages.
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={cn("flex justify-center gap-4", className)}>
      <Link href="/privacy" className="hover:text-fg hover:underline">
        Privacy Policy
      </Link>
      <Link href="/support" className="hover:text-fg hover:underline">
        Support
      </Link>
    </nav>
  );
}
