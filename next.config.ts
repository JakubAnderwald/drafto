import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default withSentryConfig(nextConfig, {
  org: "drafto",
  project: "drafto",
  silent: !process.env.CI,
  widenClientFileUpload: true,
});
