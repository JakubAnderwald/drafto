import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Metadata } from "next";
import { metadata as authGroupMetadata } from "@/app/(auth)/layout";
import LoginLayout, { metadata as loginMetadata } from "@/app/(auth)/login/layout";
import SignupLayout, { metadata as signupMetadata } from "@/app/(auth)/signup/layout";
import { metadata as privacyMetadata } from "@/app/privacy/page";
import { metadata as supportMetadata } from "@/app/support/page";
import { metadata as accountDeleteMetadata } from "@/app/account/delete/page";
import { INDEXED_PATHS } from "@/lib/site";

const INDEXED_PAGE_METADATA: Record<string, Metadata> = {
  "/login": loginMetadata,
  "/signup": signupMetadata,
  "/privacy": privacyMetadata,
  "/support": supportMetadata,
  "/account/delete": accountDeleteMetadata,
};

// The root layout's `metadataBase`, which turns these paths into absolute apex URLs, is
// checked end to end in `e2e/seo.spec.ts`: importing the layout here would pull in next/font.
describe("SEO metadata", () => {
  it.each(Object.entries(INDEXED_PAGE_METADATA))(
    "%s declares itself as its canonical URL",
    (path, metadata) => {
      expect(metadata.alternates?.canonical).toBe(path);
    },
  );

  it("lists exactly the self-canonical pages in the sitemap", () => {
    expect([...INDEXED_PATHS].sort()).toEqual(Object.keys(INDEXED_PAGE_METADATA).sort());
  });

  it("keeps the auth group's utility pages out of search results by default", () => {
    expect(authGroupMetadata.robots).toEqual({ index: false, follow: true });
  });

  it.each([
    ["/login", loginMetadata, "Log in — Drafto"],
    ["/signup", signupMetadata, "Sign up — Drafto"],
  ])("%s opts back into indexing with its own title", (_path, metadata, title) => {
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.title).toBe(title);
  });

  it.each([
    ["login", LoginLayout],
    ["signup", SignupLayout],
  ])("the metadata-only %s layout renders its page unchanged", (_name, Layout) => {
    render(
      <Layout>
        <p>page content</p>
      </Layout>,
    );

    expect(screen.getByText("page content")).toBeInTheDocument();
  });
});
