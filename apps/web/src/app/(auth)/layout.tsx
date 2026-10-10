import Link from "next/link";
import { Card, CardBody } from "@/components/ui/card";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="from-primary-50 to-secondary-50 relative flex min-h-screen items-center justify-center bg-gradient-to-br px-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h2 className="text-primary-600 text-3xl font-bold tracking-tight">Drafto</h2>
          <p className="text-fg-muted mt-1 text-sm">Your notes, beautifully organized</p>
        </div>
        <Card shadow="lg">
          <CardBody className="px-8 py-6">{children}</CardBody>
        </Card>
        {/* drafto.eu sends signed-out visitors here, so this is the public home page: it must
            say what Drafto is and link the privacy policy (Google OAuth brand verification). */}
        <footer className="text-fg-muted mt-6 text-center text-xs">
          <p>Drafto is a note-taking app for the web, iPhone, iPad, Android and Mac.</p>
          <nav aria-label="Legal" className="mt-2 flex justify-center gap-4">
            <Link href="/privacy" className="hover:text-fg hover:underline">
              Privacy Policy
            </Link>
            <Link href="/support" className="hover:text-fg hover:underline">
              Support
            </Link>
          </nav>
        </footer>
      </div>
    </div>
  );
}
