import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/.well-known/apple-app-site-association",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: "jakub-anderwald",
  project: "drafto",
  silent: !process.env.CI,
  widenClientFileUpload: true,
  release: {
    name: process.env.VERCEL_GIT_COMMIT_SHA,
  },
});
