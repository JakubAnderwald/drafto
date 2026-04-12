"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/ui/theme-toggle";

interface AppMenuProps {
  onImportEvernote: () => void;
}

function EllipsisIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z"
      />
    </svg>
  );
}

export function AppMenu({ onImportEvernote }: AppMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <div ref={containerRef} className="relative" data-testid="app-menu">
      <div className="flex items-center gap-1">
        <ThemeToggle />
        <IconButton
          size="sm"
          onClick={() => setOpen((prev) => !prev)}
          aria-label="App menu"
          data-testid="app-menu-trigger"
        >
          <EllipsisIcon />
        </IconButton>
      </div>

      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        align="right"
        className="bottom-full mb-1"
      >
        <DropdownMenuItem
          onClick={() => {
            setOpen(false);
            onImportEvernote();
          }}
          data-testid="import-evernote-button"
        >
          Import from Evernote
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setOpen(false);
            router.push("/settings");
          }}
          data-testid="settings-button"
        >
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" onClick={handleLogout} data-testid="logout-button">
          Log out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <span className="text-fg-muted block px-3 py-1.5 text-xs" data-testid="app-version">
          v.
          {process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
            ? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA.slice(0, 7)
            : "dev"}
        </span>
      </DropdownMenu>
    </div>
  );
}
