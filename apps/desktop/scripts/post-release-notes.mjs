#!/usr/bin/env node
/**
 * Post release notes to App Store Connect (TestFlight) for the macOS desktop app.
 *
 * Usage:
 *   node post-release-notes.mjs --platform macos --notes "Release notes text" --build N
 *
 * --build is the macOS build number just uploaded. It is REQUIRED: macOS and iOS
 * ship under the same App Store Connect app (eu.drafto.mobile), and iOS builds
 * ALSO carry computedMinMacOsVersion (iPhone apps run on Apple Silicon Macs), so
 * "the newest build with macOS fields" resolved to iOS build 42 and overwrote
 * its notes. Match the exact number on the MAC_OS preReleaseVersion instead.
 *
 * Environment variables:
 *   ASC_API_KEY_ID      - App Store Connect API Key ID
 *   ASC_API_ISSUER_ID   - Issuer ID
 *   ASC_API_KEY_P8      - The .p8 private key contents (PEM string)
 *   ASC_DESKTOP_APP_ID  - App Store Connect App ID for the desktop app
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  // Return the token after `flag`, but treat a missing value or the next flag as
  // absent — otherwise `--notes --build 29` would swallow `--build` as the notes.
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    const value = index === -1 ? undefined : argv[index + 1];
    return value && !value.startsWith("--") ? value : "";
  };
  return { notes: valueAfter("--notes"), build: valueAfter("--build") };
}

// --- App Store Connect ---

function base64url(data) {
  return Buffer.from(data).toString("base64url");
}

function generateAscJwt(keyId, issuerId, privateKeyP8) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: issuerId,
      iat: now,
      exp: now + 1200,
      aud: "appstoreconnect-v1",
    }),
  );

  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer
    .sign({ key: privateKeyP8, dsaEncoding: "ieee-p1363" }, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${header}.${payload}.${signature}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bound and retry every App Store Connect request.
//
// This lane used plain `fetch` with no timeout and no retry, so a hung socket
// stalled the release step indefinitely and a single transient error lost the
// notes outright: the caller (Fastlane's post_release_notes) rescues
// StandardError as non-fatal, so the build ships with an empty "What to Test"
// and nothing fails. Observed on iOS build 32, whose tester email arrived with
// no notes at all:
//   [17:54:16] TestFlight error: fetch failed
//   [17:54:28] Release notes posting failed (non-fatal)
//
// Retries cover mutations too. PATCH is idempotent, and a duplicated
// localization POST is rejected by ASC with a 409 that surfaces as a hard error
// - noisy, but never silent corruption, which is the failure mode that matters.
const ASC_REQUEST_TIMEOUT_MS = 30_000;
const ASC_RETRY_ATTEMPTS = 4;
// Read per call, not at import time, so a test can shorten the backoff without
// depending on how the runner was invoked.
const ascRetryBaseMs = () => Number(process.env.DRAFTO_ASC_RETRY_BASE_MS || 2_000);
const isTransientStatus = (status) => status === 408 || status === 429 || status >= 500;

export const ascFetch = async (url, options = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= ASC_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(ASC_REQUEST_TIMEOUT_MS),
      });
      if (isTransientStatus(res.status) && attempt < ASC_RETRY_ATTEMPTS) {
        await sleep(ascRetryBaseMs() * 2 ** (attempt - 1));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt === ASC_RETRY_ATTEMPTS) break;
      await sleep(ascRetryBaseMs() * 2 ** (attempt - 1));
    }
  }
  throw lastError;
};

// CFBundleVersion: one to three period-separated integers. Checked up front so a
// typo fails fast instead of polling App Store Connect for 5 minutes.
export const isValidBuildNumber = (build) => /^\d+(\.\d+){0,2}$/.test(String(build));

/**
 * Flatten an App Store Connect `/builds` response (data + included) into
 * `{ id, version, uploadedDate, platform }` records. `platform` comes ONLY from
 * the build's preReleaseVersion ("IOS" | "MAC_OS"). The macOS-only build fields
 * are not a usable fallback here: iOS builds report computedMinMacOsVersion too.
 */
export function normalizeBuilds(buildsResponse) {
  const preReleaseById = new Map(
    (buildsResponse.included || [])
      .filter((item) => item.type === "preReleaseVersions")
      .map((item) => [item.id, item.attributes]),
  );
  return (buildsResponse.data || []).map((build) => {
    const preReleaseId = build.relationships?.preReleaseVersion?.data?.id;
    return {
      id: build.id,
      version: build.attributes?.version,
      uploadedDate: build.attributes?.uploadedDate,
      platform: preReleaseId ? preReleaseById.get(preReleaseId)?.platform : undefined,
    };
  });
}

/**
 * Pick the macOS build with exactly `buildNumber`. Build numbers are not unique
 * across platforms (iOS and macOS count independently), so filter to MAC_OS
 * first; among survivors the most recently uploaded wins.
 */
export function selectMacBuild(builds, { buildNumber }) {
  const candidates = builds.filter(
    (build) => build.platform === "MAC_OS" && String(build.version) === String(buildNumber),
  );
  if (candidates.length === 0) {
    return null;
  }
  const uploadedAt = (build) => (build.uploadedDate ? Date.parse(build.uploadedDate) : 0);
  return candidates.reduce((newest, build) =>
    uploadedAt(build) > uploadedAt(newest) ? build : newest,
  );
}

async function postTestFlightNotes(releaseNotes, buildNumber) {
  const keyId = process.env.ASC_API_KEY_ID;
  const issuerId = process.env.ASC_API_ISSUER_ID;
  const privateKeyP8 =
    process.env.ASC_API_KEY_P8 ||
    (() => {
      const pathFromEnv = process.env.ASC_API_KEY_P8_PATH;
      const candidates = [pathFromEnv, "appstore-api-key.p8"].filter(Boolean);
      for (const p of candidates) {
        try {
          return readFileSync(p, "utf-8");
        } catch {
          // try next candidate
        }
      }
      return null;
    })();

  if (!keyId || !issuerId || !privateKeyP8) {
    console.error(
      "Skipping TestFlight: missing ASC_API_KEY_ID, ASC_API_ISSUER_ID, or ASC_API_KEY_P8",
    );
    return;
  }

  const appId = process.env.ASC_DESKTOP_APP_ID || "6760675784";

  const jwt = generateAscJwt(keyId, issuerId, privateKeyP8);
  const baseUrl = "https://api.appstoreconnect.apple.com/v1";
  const headers = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };

  // 1. Find the exact macOS build. The lane uploads with
  // skip_waiting_for_build_processing, so a fresh build may not be indexed yet —
  // poll until it appears. filter[version] rather than sort-by-uploadedDate: a
  // still-processing build has a null uploadedDate and sorts last.
  // `preReleaseVersion` MUST be in fields[builds] or ASC omits the relationship
  // linkage and the platform can't be resolved from the include.
  const buildsUrl =
    `${baseUrl}/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}` +
    `&fields[builds]=version,uploadedDate,processingState,preReleaseVersion` +
    `&include=preReleaseVersion&fields[preReleaseVersions]=platform`;
  const maxAttempts = 15;
  let target = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const buildsRes = await ascFetch(buildsUrl, { headers });
    if (!buildsRes.ok) {
      throw new Error(`List builds failed: ${buildsRes.status} ${await buildsRes.text()}`);
    }
    target = selectMacBuild(normalizeBuilds(await buildsRes.json()), { buildNumber });
    if (target || attempt === maxAttempts) {
      break;
    }
    console.log(
      `TestFlight: macOS build ${buildNumber} not indexed yet (attempt ${attempt}/${maxAttempts}); retrying in 20s…`,
    );
    await sleep(20_000);
  }

  if (!target) {
    console.error(
      `Skipping TestFlight: macOS build ${buildNumber} not found for app ${appId} after ${maxAttempts} attempts`,
    );
    return;
  }

  const buildId = target.id;

  // 2. Check if a betaBuildLocalization already exists for en-US
  const locRes = await ascFetch(
    `${baseUrl}/builds/${buildId}/betaBuildLocalizations?fields[betaBuildLocalizations]=locale,whatsNew`,
    { headers },
  );
  if (!locRes.ok) {
    throw new Error(`List localizations failed: ${locRes.status} ${await locRes.text()}`);
  }
  const locData = await locRes.json();

  const trimmedNotes = releaseNotes.slice(0, 4000);
  const existing = locData.data.find((l) => l.attributes.locale === "en-US");

  if (existing) {
    // 3a. Update existing localization
    const updateRes = await ascFetch(`${baseUrl}/betaBuildLocalizations/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        data: {
          id: existing.id,
          type: "betaBuildLocalizations",
          attributes: { whatsNew: trimmedNotes },
        },
      }),
    });
    if (!updateRes.ok) {
      throw new Error(`Update localization failed: ${updateRes.status} ${await updateRes.text()}`);
    }
  } else {
    // 3b. Create new localization
    const createRes = await ascFetch(`${baseUrl}/betaBuildLocalizations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: "en-US", whatsNew: trimmedNotes },
          relationships: { build: { data: { id: buildId, type: "builds" } } },
        },
      }),
    });
    if (!createRes.ok) {
      throw new Error(`Create localization failed: ${createRes.status} ${await createRes.text()}`);
    }
  }

  console.log(`TestFlight: "What to Test" updated for macOS build ${target.version}`);
}

// --- Main ---

async function main() {
  const { notes, build } = parseArgs(process.argv.slice(2));
  if (!notes) {
    console.error("Error: --notes is required");
    process.exit(1);
  }
  if (!build) {
    console.error("Error: --build is required so notes target THAT macOS build");
    process.exit(1);
  }
  if (!isValidBuildNumber(build)) {
    console.error(`Error: --build "${build}" is not a CFBundleVersion (e.g. 56 or 1.2.3)`);
    process.exit(1);
  }
  try {
    await postTestFlightNotes(notes, build);
  } catch (err) {
    console.error(`TestFlight error: ${err.message}`);
    process.exit(1);
  }
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
