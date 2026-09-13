#!/usr/bin/env node
/**
 * Post release notes to App Store Connect (TestFlight) for the macOS desktop app.
 *
 * Usage:
 *   node post-release-notes.mjs --platform macos --notes "Release notes text"
 *
 * Environment variables:
 *   ASC_API_KEY_ID      - App Store Connect API Key ID
 *   ASC_API_ISSUER_ID   - Issuer ID
 *   ASC_API_KEY_P8      - The .p8 private key contents (PEM string)
 *   ASC_DESKTOP_APP_ID  - App Store Connect App ID for the desktop app
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const notesIdx = args.indexOf("--notes");
const notes = notesIdx !== -1 ? args[notesIdx + 1] : "";

if (!notes) {
  console.error("Error: --notes is required");
  process.exit(1);
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

async function postTestFlightNotes(releaseNotes) {
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

  // 1. Find the latest macOS build (filter by platform-identifying fields for multi-platform app).
  // Uses the top-level /v1/builds endpoint because the relationship endpoint /v1/apps/{id}/builds
  // no longer accepts the `sort` query parameter.
  const buildsRes = await ascFetch(
    `${baseUrl}/builds?filter[app]=${appId}&sort=-uploadedDate&limit=10&fields[builds]=version,processingState,computedMinMacOsVersion,lsMinimumSystemVersion`,
    { headers },
  );
  if (!buildsRes.ok) {
    throw new Error(`List builds failed: ${buildsRes.status} ${await buildsRes.text()}`);
  }
  const buildsData = await buildsRes.json();

  if (!buildsData.data || buildsData.data.length === 0) {
    console.error("Skipping TestFlight: no builds found");
    return;
  }

  // Filter to macOS builds only (have computedMinMacOsVersion or lsMinimumSystemVersion)
  const macosBuild = buildsData.data.find(
    (b) => b.attributes.computedMinMacOsVersion || b.attributes.lsMinimumSystemVersion,
  );

  if (!macosBuild) {
    console.error("Skipping TestFlight: no macOS builds found (only iOS builds present)");
    return;
  }

  const buildId = macosBuild.id;

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

  console.log(
    `TestFlight: "What to Test" updated for macOS build ${macosBuild.attributes.version}`,
  );
}

// --- Main ---

async function main() {
  try {
    await postTestFlightNotes(notes);
  } catch (err) {
    console.error(`TestFlight error: ${err.message}`);
    process.exit(1);
  }
}

main();
