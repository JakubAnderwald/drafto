"use client";

import { useTheme } from "@/hooks/use-theme";
import { IconButton } from "@/components/ui/icon-button";
import type { Theme } from "@/hooks/use-theme";

const CYCLE_ORDER: Theme[] = ["light", "dark", "system"];

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, resolvedTheme, setTheme } = useTheme();

  const handleClick = () => {
    const currentIndex = CYCLE_ORDER.indexOf(theme);
    const nextTheme = CYCLE_ORDER[(currentIndex + 1) % CYCLE_ORDER.length];
    setTheme(nextTheme);
  };

  const label =
    theme === "system"
      ? `System theme (${resolvedTheme})`
      : theme === "dark"
        ? "Dark mode"
        : "Light mode";

  return (
    <IconButton
      aria-label={label}
      onClick={handleClick}
      size="sm"
      className={className}
      data-testid="theme-toggle"
    >
      {resolvedTheme === "dark" ? <MoonIcon /> : <SunIcon />}
    </IconButton>
  );
}

function SunIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}
