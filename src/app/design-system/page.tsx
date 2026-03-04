"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardBody, CardFooter } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/* ── Prop interfaces ──────────────────────────────────────── */

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

interface SwatchProps {
  name: string;
  cssVar: string;
  hex?: string;
}

interface ColorScaleShade {
  shade: string;
  hex: string;
}

interface ColorScaleProps {
  label: string;
  prefix: string;
  shades: readonly ColorScaleShade[];
}

/* ── Token data ───────────────────────────────────────────── */

const PRIMARY_SHADES: readonly ColorScaleShade[] = [
  { shade: "50", hex: "#eef2ff" },
  { shade: "100", hex: "#e0e7ff" },
  { shade: "200", hex: "#c7d2fe" },
  { shade: "300", hex: "#a5b4fc" },
  { shade: "400", hex: "#818cf8" },
  { shade: "500", hex: "#6366f1" },
  { shade: "600", hex: "#4f46e5" },
  { shade: "700", hex: "#4338ca" },
  { shade: "800", hex: "#3730a3" },
  { shade: "900", hex: "#312e81" },
];

const ACCENT_SHADES: readonly ColorScaleShade[] = [
  { shade: "50", hex: "#fffbeb" },
  { shade: "100", hex: "#fef3c7" },
  { shade: "200", hex: "#fde68a" },
  { shade: "300", hex: "#fcd34d" },
  { shade: "400", hex: "#fbbf24" },
  { shade: "500", hex: "#f59e0b" },
  { shade: "600", hex: "#d97706" },
];

const NEUTRAL_SHADES: readonly ColorScaleShade[] = [
  { shade: "50", hex: "#fafaf9" },
  { shade: "100", hex: "#f5f5f4" },
  { shade: "200", hex: "#e7e5e4" },
  { shade: "300", hex: "#d6d3d1" },
  { shade: "400", hex: "#a8a29e" },
  { shade: "500", hex: "#78716c" },
  { shade: "600", hex: "#57534e" },
  { shade: "700", hex: "#44403c" },
  { shade: "800", hex: "#292524" },
  { shade: "900", hex: "#1c1917" },
];

const SEMANTIC_SWATCHES = [
  { name: "Background", cssVar: "--bg" },
  { name: "Background Subtle", cssVar: "--bg-subtle" },
  { name: "Background Muted", cssVar: "--bg-muted" },
  { name: "Foreground", cssVar: "--fg" },
  { name: "Foreground Muted", cssVar: "--fg-muted" },
  { name: "Foreground Subtle", cssVar: "--fg-subtle" },
  { name: "Border", cssVar: "--border" },
  { name: "Border Strong", cssVar: "--border-strong" },
  { name: "Ring / Focus", cssVar: "--ring" },
  { name: "Sidebar BG", cssVar: "--sidebar-bg" },
  { name: "Sidebar Hover", cssVar: "--sidebar-hover" },
  { name: "Sidebar Active", cssVar: "--sidebar-active" },
] as const;

const STATUS_TOKENS = [
  { name: "Success", bg: "--success-bg", text: "--success-text" },
  { name: "Warning", bg: "--warning-bg", text: "--warning-text" },
  { name: "Error", bg: "--error-bg", text: "--error-text" },
] as const;

const SHADOW_SIZES = ["xs", "sm", "md", "lg"] as const;

const RADIUS_TOKENS = [
  { token: "sm", value: "0.25rem" },
  { token: "md", value: "0.375rem" },
  { token: "lg", value: "0.5rem" },
  { token: "xl", value: "0.75rem" },
  { token: "full", value: "9999px" },
] as const;

/* ── Helper components ────────────────────────────────────── */

function Section({ title, children }: SectionProps) {
  return (
    <section className="mb-16">
      <h2 className="border-border mb-6 border-b pb-2 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ name, cssVar, hex }: SwatchProps) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="border-border h-10 w-10 rounded-lg border shadow-xs"
        style={{ backgroundColor: `var(${cssVar})` }}
      />
      <div>
        <p className="text-sm font-medium">{name}</p>
        <p className="text-fg-muted font-mono text-xs">
          {cssVar}
          {hex ? ` (${hex})` : ""}
        </p>
      </div>
    </div>
  );
}

function ColorScale({ label, prefix, shades }: ColorScaleProps) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{label}</p>
      <div className="flex gap-1">
        {shades.map((s) => (
          <div key={s.shade} className="text-center">
            <div
              className="border-border h-10 w-12 rounded-md border"
              style={{
                backgroundColor: `var(--color-${prefix}-${s.shade})`,
              }}
            />
            <p className="text-fg-muted mt-1 font-mono text-[10px]">{s.shade}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────── */

export default function DesignSystemPage() {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="space-y-4">
      {/* Theme toggle */}
      <div className="flex items-center justify-end gap-2">
        <span className="text-fg-muted text-sm">Toggle theme:</span>
        <ThemeToggle />
      </div>

      {/* ── Color Tokens ─────────────────────────────────── */}
      <Section title="Color Scales">
        <div className="space-y-6">
          <ColorScale label="Primary (Indigo)" prefix="primary" shades={PRIMARY_SHADES} />
          <ColorScale label="Accent (Amber)" prefix="accent" shades={ACCENT_SHADES} />
          <ColorScale label="Neutral (Stone)" prefix="neutral" shades={NEUTRAL_SHADES} />
        </div>
      </Section>

      <Section title="Semantic Surfaces">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {SEMANTIC_SWATCHES.map((swatch) => (
            <Swatch key={swatch.cssVar} name={swatch.name} cssVar={swatch.cssVar} />
          ))}
        </div>
      </Section>

      <Section title="Status Colors">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {STATUS_TOKENS.map((s) => (
            <div
              key={s.name}
              className="border-border flex items-center gap-3 rounded-lg border p-3"
              style={{ backgroundColor: `var(${s.bg})` }}
            >
              <span className="text-sm font-medium" style={{ color: `var(${s.text})` }}>
                {s.name}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Typography ───────────────────────────────────── */}
      <Section title="Typography">
        <div className="space-y-4">
          <div>
            <p className="text-fg-muted mb-1 font-mono text-xs">font-sans (Geist Sans)</p>
            <p className="text-4xl font-bold">Heading 1 — The quick brown fox</p>
            <p className="text-2xl font-semibold">Heading 2 — The quick brown fox</p>
            <p className="text-xl font-semibold">Heading 3 — The quick brown fox</p>
            <p className="text-lg font-medium">Heading 4 — The quick brown fox</p>
            <p className="text-base">Body — The quick brown fox jumps over the lazy dog.</p>
            <p className="text-fg-muted text-sm">
              Small / Muted — The quick brown fox jumps over the lazy dog.
            </p>
            <p className="text-fg-subtle text-xs">
              Extra Small / Subtle — The quick brown fox jumps over the lazy dog.
            </p>
          </div>
          <div>
            <p className="text-fg-muted mb-1 font-mono text-xs">font-mono (Geist Mono)</p>
            <p className="font-mono text-sm">const greeting = &quot;Hello, Drafto!&quot;;</p>
          </div>
        </div>
      </Section>

      {/* ── Shadows ──────────────────────────────────────── */}
      <Section title="Shadows">
        <div className="flex flex-wrap gap-6">
          {SHADOW_SIZES.map((s) => (
            <div
              key={s}
              className="border-border bg-bg flex h-20 w-32 items-center justify-center rounded-lg border"
              style={{ boxShadow: `var(--shadow-${s})` }}
            >
              <span className="text-fg-muted font-mono text-xs">shadow-{s}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Radius ───────────────────────────────────────── */}
      <Section title="Border Radius">
        <div className="flex flex-wrap gap-6">
          {RADIUS_TOKENS.map((r) => (
            <div key={r.token} className="text-center">
              <div
                className="border-primary-500 bg-primary-100 mx-auto h-16 w-16 border-2"
                style={{ borderRadius: `var(--radius-${r.token})` }}
              />
              <p className="text-fg-muted mt-2 font-mono text-xs">
                {r.token} ({r.value})
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Components ───────────────────────────────────── */}
      <Section title="Button">
        <div className="space-y-4">
          <div>
            <p className="text-fg-muted mb-2 text-sm">Variants</p>
            <div className="flex flex-wrap gap-3">
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="success">Success</Button>
            </div>
          </div>
          <div>
            <p className="text-fg-muted mb-2 text-sm">Sizes</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
            </div>
          </div>
          <div>
            <p className="text-fg-muted mb-2 text-sm">States</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button loading>Loading</Button>
              <Button disabled>Disabled</Button>
            </div>
          </div>
        </div>
      </Section>

      <Section title="IconButton">
        <div className="space-y-4">
          <div>
            <p className="text-fg-muted mb-2 text-sm">Variants &amp; Sizes</p>
            <div className="flex flex-wrap items-center gap-3">
              <IconButton aria-label="Ghost small" size="sm" variant="ghost">
                <PencilIcon />
              </IconButton>
              <IconButton aria-label="Ghost medium" size="md" variant="ghost">
                <PencilIcon />
              </IconButton>
              <IconButton aria-label="Ghost large" size="lg" variant="ghost">
                <PencilIcon />
              </IconButton>
              <IconButton aria-label="Danger" variant="danger">
                <TrashIcon />
              </IconButton>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Input & Label">
        <div className="max-w-sm space-y-4">
          <div>
            <Label htmlFor="demo-sm">Small input</Label>
            <Input id="demo-sm" inputSize="sm" placeholder="Small..." />
          </div>
          <div>
            <Label htmlFor="demo-md" required>
              Medium input (required)
            </Label>
            <Input id="demo-md" inputSize="md" placeholder="Medium..." />
          </div>
          <div>
            <Label htmlFor="demo-lg">Large input</Label>
            <Input id="demo-lg" inputSize="lg" placeholder="Large..." />
          </div>
          <div>
            <Label htmlFor="demo-err">Error state</Label>
            <Input id="demo-err" error placeholder="Something went wrong..." />
          </div>
        </div>
      </Section>

      <Section title="Badge">
        <div className="flex flex-wrap gap-3">
          <Badge>Default</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="error">Error</Badge>
        </div>
      </Section>

      <Section title="Card">
        <div className="grid gap-6 sm:grid-cols-3">
          {(["sm", "md", "lg"] as const).map((s) => (
            <Card key={s} shadow={s}>
              <CardHeader>
                <h3 className="font-semibold">Card — shadow-{s}</h3>
              </CardHeader>
              <CardBody>
                <p className="text-fg-muted text-sm">This is the card body content.</p>
              </CardBody>
              <CardFooter>
                <p className="text-fg-subtle text-xs">Footer</p>
              </CardFooter>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Skeleton">
        <div className="space-y-3">
          <Skeleton width="100%" height="1rem" rounded="md" />
          <Skeleton width="75%" height="1rem" rounded="md" />
          <Skeleton width="50%" height="1rem" rounded="md" />
          <div className="flex gap-3">
            <Skeleton width="3rem" height="3rem" rounded="full" />
            <div className="flex-1 space-y-2">
              <Skeleton width="60%" height="0.75rem" />
              <Skeleton width="40%" height="0.75rem" />
            </div>
          </div>
        </div>
      </Section>

      <Section title="DropdownMenu">
        <div className="relative inline-block">
          <Button variant="secondary" onClick={() => setDropdownOpen(!dropdownOpen)}>
            Open menu
          </Button>
          <DropdownMenu open={dropdownOpen} onClose={() => setDropdownOpen(false)} align="left">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setDropdownOpen(false)}>Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDropdownOpen(false)}>Duplicate</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="danger" onClick={() => setDropdownOpen(false)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenu>
        </div>
      </Section>

      <Section title="ConfirmDialog">
        <Button variant="danger" onClick={() => setConfirmOpen(true)}>
          Show confirm dialog
        </Button>
        {confirmOpen && (
          <div className="mt-4 max-w-md">
            <ConfirmDialog
              title="Delete this item?"
              confirmLabel="Delete"
              cancelLabel="Cancel"
              variant="danger"
              onConfirm={() => setConfirmOpen(false)}
              onCancel={() => setConfirmOpen(false)}
            >
              <p className="text-fg-muted text-sm">
                This action cannot be undone. The item will be permanently removed.
              </p>
            </ConfirmDialog>
          </div>
        )}
      </Section>
    </div>
  );
}

/* ── Inline icons for the showcase ────────────────────────── */

function PencilIcon() {
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
      focusable="false"
    >
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function TrashIcon() {
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
      focusable="false"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}
