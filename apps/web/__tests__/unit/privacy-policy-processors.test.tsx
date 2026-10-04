import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import PrivacyPolicyPage from "@/app/privacy/page";

/**
 * Keeps the privacy policy in step with the code (docs/features/privacy-policy.md).
 *
 * The dependency scan only sees npm packages. A service reached over plain `fetch`, or from
 * a script on the Mac mini (the support pipeline's Zoho Mail, Anthropic and GitHub), is
 * invisible to it — those are pinned by EXPECTED_ROWS below and by the Privacy Policy
 * Maintenance rule in CLAUDE.md.
 */

// Dependency name → the processor the privacy page must name.
const PROCESSOR_FOR_DEPENDENCY: Array<[pattern: RegExp, processor: string]> = [
  [/^@sentry\//, "Sentry"],
  [/^posthog-/, "PostHog"],
  [/^resend$/, "Resend"],
  [/^@react-native-google-signin\//, "Google"],
  [/^expo-apple-authentication$/, "Apple"],
  [/^@supabase\//, "Supabase"],
  // On iOS and macOS its default reachability check calls clients3.google.com every minute.
  [/^@react-native-community\/netinfo$/, "Google"],
];

// Analytics and crash-reporting SDKs. The page says the native apps ship none, so one in
// apps/mobile or apps/desktop fails even when the page already names its processor for the web.
const TELEMETRY: RegExp[] = [
  /analytics/,
  /sentry/,
  /posthog/,
  /amplitude/,
  /mixpanel/,
  /segment/,
  /firebase/,
  /crashlytics/,
  /bugsnag/,
  /rollbar/,
  /datadog/,
  /newrelic/,
  /logrocket/,
  /fullstory/,
  /hotjar/,
  /speed-insights/,
];

// Names that usually mean "this SDK sends data to someone". A match that is not in the map
// above fails the test, so adding one forces a decision about the policy.
const SUSPICIOUS: RegExp[] = [
  ...TELEMETRY,
  /^expo-updates$/,
  /^expo-notifications$/,
  /openai/,
  /@anthropic-ai\//,
  /@ai-sdk\//,
  /^ai$/,
  /@google\/(genai|generative-ai)/,
  /mistral/,
  /cohere/,
  /onesignal/,
  /intercom/,
  /sendgrid/,
  /mailgun/,
  /postmark/,
  /stripe/,
];

// Dependencies that match SUSPICIOUS but send no user data, each with the reason.
const NOT_A_PROCESSOR: Record<string, string> = {};

// Mapped processors that receive nothing today, so the page names them in the text instead of
// giving them a sharing-table row, each with the reason. Every other mapped processor needs a row.
const NAMED_IN_TEXT_ONLY: Record<string, string> = {
  PostHog: "no PostHog key is configured, so the SDK sends nothing",
};

const NATIVE_APPS = ["apps/mobile", "apps/desktop"];
const PACKAGES = ["apps/web", ...NATIVE_APPS, "packages/shared"];
// `import.meta.url` is an http: URL under jsdom, so resolve from the file path instead.
const REPO_ROOT = path.resolve(__dirname, "../../../..");

// Every processor row the sharing table must have, including services no package.json shows.
const EXPECTED_ROWS = [
  "Supabase",
  "Vercel",
  "Sentry",
  "Resend",
  "Google",
  "Apple",
  "Zoho Mail",
  "Anthropic",
  "GitHub",
];

function dependenciesOf(dir: string): string[] {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
}

function processorFor(dependency: string): string | undefined {
  return PROCESSOR_FOR_DEPENDENCY.find(([pattern]) => pattern.test(dependency))?.[1];
}

interface RenderedPolicy {
  text: string;
  tableServices: string[];
}

function isDisclosed(processor: string, policy: RenderedPolicy): boolean {
  if (processor in NAMED_IN_TEXT_ONLY) return new RegExp(`\\b${processor}\\b`).test(policy.text);
  return policy.tableServices.includes(processor);
}

function undisclosed(dependencies: string[], policy: RenderedPolicy): string[] {
  return dependencies.flatMap((dependency) => {
    const processor = processorFor(dependency);
    if (!processor || isDisclosed(processor, policy)) return [];
    return [`${dependency} → ${processor}`];
  });
}

function unmappedSuspicious(dependencies: string[]): string[] {
  return dependencies.filter(
    (dependency) =>
      SUSPICIOUS.some((pattern) => pattern.test(dependency)) &&
      !processorFor(dependency) &&
      !(dependency in NOT_A_PROCESSOR),
  );
}

function telemetry(dependencies: string[]): string[] {
  return dependencies.filter(
    (dependency) =>
      TELEMETRY.some((pattern) => pattern.test(dependency)) && !(dependency in NOT_A_PROCESSOR),
  );
}

function renderedPolicy(): RenderedPolicy {
  render(<PrivacyPolicyPage />);
  const table = screen.getByRole("table");
  return {
    text: document.body.textContent ?? "",
    tableServices: within(table)
      .getAllByRole("row")
      .slice(1) // header row
      .map((row) => within(row).getAllByRole("cell")[0].textContent ?? ""),
  };
}

const allDependencies = [...new Set(PACKAGES.flatMap(dependenciesOf))];

describe("privacy policy sharing table", () => {
  it("lists every processor", () => {
    expect(renderedPolicy().tableServices).toEqual(expect.arrayContaining(EXPECTED_ROWS));
  });

  it("has no row for services that receive no user data", () => {
    const services = renderedPolicy().tableServices;
    // Builds are local Fastlane and OTA updates are off, so Expo receives nothing.
    expect(services.some((service) => /Expo/.test(service))).toBe(false);
    // No PostHog key is configured, so nothing reaches PostHog (named in the text instead).
    expect(services.some((service) => /PostHog/.test(service))).toBe(false);
  });
});

describe("privacy policy dependency guard", () => {
  it("reads the app package.json files", () => {
    expect(allDependencies).toContain("@sentry/nextjs");
    expect(allDependencies).toContain("expo-apple-authentication");
  });

  it("gives the processor of every data-processing dependency a sharing-table row", () => {
    // Fix: add a row for the processor to the sharing table on /privacy (and bump "Last
    // updated"). A processor that receives nothing yet goes in NAMED_IN_TEXT_ONLY instead.
    expect(undisclosed(allDependencies, renderedPolicy())).toEqual([]);
  });

  it("has a policy decision for every dependency with a data-processing name", () => {
    // Fix: map it in PROCESSOR_FOR_DEPENDENCY and describe it on /privacy, or, if it sends no
    // user data, add it to NOT_A_PROCESSOR with the reason.
    expect(unmappedSuspicious(allDependencies)).toEqual([]);
  });

  it("keeps the claim that the native apps have no analytics or crash-reporting SDK true", () => {
    // Fix: if a native app now ships one, rewrite that paragraph on /privacy and this test.
    expect(renderedPolicy().text).toMatch(
      /The iOS, Android and macOS apps contain no analytics or crash-reporting SDK/,
    );
    expect(telemetry(NATIVE_APPS.flatMap(dependenciesOf))).toEqual([]);
  });

  it("flags a mapped dependency whose processor has no sharing-table row", () => {
    // Naming the processor in the text is not enough.
    const policy = { text: "Errors are reported to Sentry.", tableServices: ["Supabase"] };
    expect(undisclosed(["@sentry/react-native", "react"], policy)).toEqual([
      "@sentry/react-native → Sentry",
    ]);
    expect(undisclosed(["resend"], { text: "", tableServices: ["Resend"] })).toEqual([]);
  });

  it("accepts a text-only mention for a processor that receives nothing today", () => {
    expect(
      undisclosed(["posthog-js"], { text: "PostHog is not enabled.", tableServices: [] }),
    ).toEqual([]);
    expect(undisclosed(["posthog-js"], { text: "", tableServices: [] })).toEqual([
      "posthog-js → PostHog",
    ]);
  });

  it("flags a telemetry SDK even when its processor is already named on the page", () => {
    expect(telemetry(["@sentry/react-native", "react-native-svg", "expo-secure-store"])).toEqual([
      "@sentry/react-native",
    ]);
  });

  it("flags a data-processing dependency that is missing from the map", () => {
    expect(
      unmappedSuspicious([
        "@vercel/analytics",
        "openai",
        "ai",
        "expo-updates",
        "react",
        "@sentry/nextjs",
        "expo-secure-store",
      ]),
    ).toEqual(["@vercel/analytics", "openai", "ai", "expo-updates"]);
  });
});
