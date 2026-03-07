import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default withSentryConfig(nextConfig, {
  org: "jakub-anderwald",
  project: "drafto",
  silent: !process.env.CI,
  widenClientFileUpload: true,
});
