#!/usr/bin/env node
/**
 * Post release notes to Google Play and/or App Store Connect (TestFlight).
 *
 * Usage:
 *   node post-release-notes.mjs --platform android|ios|all --notes "Release notes text" [--build N]
 *
 * --build is the iOS build number just uploaded. It is REQUIRED for correct
 * TestFlight targeting: macOS (desktop) and iOS ship under the same App Store
 * Connect app (eu.drafto.mobile), so without an exact build match the "newest
 * uploaded build" can be a macOS build and the iOS notes land on the wrong build.
 *
 * Environment variables:
 *   Google Play (android):
 *     GOOGLE_PLAY_SERVICE_ACCOUNT_KEY - JSON string of the service account key
 *     GOOGLE_PLAY_PACKAGE_NAME        - defaults to "eu.drafto.mobile"
 *     GOOGLE_PLAY_TRACK               - defaults to "internal"
 *
 *   App Store Connect (ios):
 *     ASC_API_KEY_ID    - App Store Connect API Key ID
 *     ASC_API_ISSUER_ID - Issuer ID
 *     ASC_API_KEY_P8    - The .p8 private key contents (PEM string)
 *     ASC_APP_ID        - App Store Connect App ID (defaults to "6760675784")
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VALID_PLATFORMS = ["android", "ios", "all"];

function parseArgs(argv) {
  const platformIdx = argv.indexOf("--platform");
  const notesIdx = argv.indexOf("--notes");
  const buildIdx = argv.indexOf("--build");
  return {
    platform: platformIdx !== -1 ? argv[platformIdx + 1] : "all",
    notes: notesIdx !== -1 ? argv[notesIdx + 1] : "",
    build: buildIdx !== -1 ? argv[buildIdx + 1] : "",
  };
}

// --- Google Play ---

function base64url(data) {
  return Buffer.from(data).toString("base64url");
}

async function getGoogleAccessToken(serviceAccountKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: serviceAccountKey.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(serviceAccountKey.private_key, "base64url");

  const jwt = `${header}.${payload}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    throw new Error(`Google OAuth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function postGooglePlayNotes(releaseNotes) {
  const keySource =
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY ||
    (() => {
      try {
        return readFileSync("google-play-service-account.json", "utf-8");
      } catch {
        return null;
      }
    })();

  if (!keySource) {
    console.error(
      "Skipping Google Play: no GOOGLE_PLAY_SERVICE_ACCOUNT_KEY env var or google-play-service-account.json file",
    );
    return;
  }

  const serviceAccountKey = JSON.parse(keySource);
  const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME || "eu.drafto.mobile";
  const track = process.env.GOOGLE_PLAY_TRACK || "internal";
  const accessToken = await getGoogleAccessToken(serviceAccountKey);

  const baseUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  // 1. Create an edit
  const editRes = await fetch(`${baseUrl}/edits`, { method: "POST", headers });
  if (!editRes.ok) {
    throw new Error(`Create edit failed: ${editRes.status} ${await editRes.text()}`);
  }
  const edit = await editRes.json();

  // 2. Get the current track to find the latest release
  const trackRes = await fetch(`${baseUrl}/edits/${edit.id}/tracks/${track}`, { headers });
  if (!trackRes.ok) {
    throw new Error(`Get track failed: ${trackRes.status} ${await trackRes.text()}`);
  }
  const trackData = await trackRes.json();

  // 3. Update releases with release notes (limit 500 chars for Google Play)
  const trimmedNotes = releaseNotes.slice(0, 500);
  const updatedReleases = trackData.releases.map((release) => ({
    ...release,
    releaseNotes: [{ language: "en-US", text: trimmedNotes }],
  }));

  const updateRes = await fetch(`${baseUrl}/edits/${edit.id}/tracks/${track}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ track, releases: updatedReleases }),
  });
  if (!updateRes.ok) {
    throw new Error(`Update track failed: ${updateRes.status} ${await updateRes.text()}`);
  }

  // 4. Commit the edit
  const commitRes = await fetch(`${baseUrl}/edits/${edit.id}:commit`, { method: "POST", headers });
  if (!commitRes.ok) {
    throw new Error(`Commit edit failed: ${commitRes.status} ${await commitRes.text()}`);
  }

  console.log(`Google Play (${track}): release notes updated`);
}

// --- App Store Connect ---

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

/**
 * Flatten an App Store Connect `/builds` response (data + included) into
 * `{ id, version, uploadedDate, platform }` records. `platform` comes from the
 * build's preReleaseVersion ("IOS" | "MAC_OS") — the query MUST list
 * `preReleaseVersion` in `fields[builds]` for that relationship linkage to be
 * present. As a defensive fallback (linkage absent) we use the macOS-only build
 * fields (computedMinMacOsVersion / lsMinimumSystemVersion) whose presence
 * identifies a macOS build.
 */
export function normalizeBuilds(buildsResponse) {
  const preReleaseById = new Map(
    (buildsResponse.included || [])
      .filter((item) => item.type === "preReleaseVersions")
      .map((item) => [item.id, item.attributes]),
  );
  return (buildsResponse.data || []).map((build) => {
    const attrs = build.attributes || {};
    const preReleaseId = build.relationships?.preReleaseVersion?.data?.id;
    const preReleasePlatform = preReleaseId
      ? preReleaseById.get(preReleaseId)?.platform
      : undefined;
    const hasMacFields = Boolean(attrs.computedMinMacOsVersion || attrs.lsMinimumSystemVersion);
    return {
      id: build.id,
      version: attrs.version,
      uploadedDate: attrs.uploadedDate,
      platform: preReleasePlatform || (hasMacFields ? "MAC_OS" : "IOS"),
    };
  });
}

/**
 * Pick the iOS TestFlight build to attach "What to Test" notes to.
 *
 * macOS (desktop) and iOS ship under the SAME App Store Connect app, so "the
 * newest uploaded build" can be a macOS build — which is exactly how iOS notes
 * once overwrote a desktop build's notes. Always restrict to iOS.
 *
 * Build numbers are NOT unique: macOS and iOS increment independently, so the same
 * number exists on both platforms (e.g. an old macOS build 29 alongside the new
 * iOS build 29). When a build number is known we filter to iOS builds with that
 * exact number; among the survivors (and in the no-number fallback) we pick the
 * most recently uploaded so a reused number can't resolve to a stale build.
 *
 * @param {{id: string, version: string, uploadedDate?: string, platform: string}[]} builds
 * @param {{buildNumber?: string|number}} [opts]
 */
export function selectTestFlightBuild(builds, { buildNumber } = {}) {
  let candidates = builds.filter((build) => build.platform === "IOS");
  if (buildNumber !== undefined && buildNumber !== null && String(buildNumber) !== "") {
    candidates = candidates.filter((build) => String(build.version) === String(buildNumber));
  }
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

  const appId = process.env.ASC_APP_ID || "6760675784";
  const jwt = generateAscJwt(keyId, issuerId, privateKeyP8);
  const baseUrl = "https://api.appstoreconnect.apple.com/v1";
  const headers = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };

  // 1. Find the iOS build to attach notes to. macOS + iOS share this ASC app, so
  // we filter to iOS and match the exact build number. A freshly uploaded build
  // may still be processing / not yet indexed (the lane uploads with
  // skip_waiting_for_build_processing), so poll until it appears.
  //
  // When the build number is known, filter by it directly (`filter[version]`)
  // rather than sorting by uploadedDate: a still-processing build has a null
  // uploadedDate and sorts LAST, so with many historical builds it could fall off
  // a paged newest-first list entirely. Uses the top-level /v1/builds endpoint
  // because the relationship endpoint /v1/apps/{id}/builds no longer accepts these
  // query params; include preReleaseVersion so we can read each build's platform.
  // `preReleaseVersion` MUST be in fields[builds] or ASC omits the relationship
  // linkage and platform can't be resolved from the include; uploadedDate breaks
  // ties when a build number is reused; the macOS-only fields are a fallback.
  const commonFields =
    `&fields[builds]=version,uploadedDate,processingState,preReleaseVersion,computedMinMacOsVersion,lsMinimumSystemVersion` +
    `&include=preReleaseVersion&fields[preReleaseVersions]=platform`;
  const buildsUrl = buildNumber
    ? `${baseUrl}/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}${commonFields}`
    : `${baseUrl}/builds?filter[app]=${appId}&sort=-uploadedDate&limit=20${commonFields}`;
  const maxAttempts = buildNumber ? 15 : 1;
  let target = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const buildsRes = await fetch(buildsUrl, { headers });
    if (!buildsRes.ok) {
      throw new Error(`List builds failed: ${buildsRes.status} ${await buildsRes.text()}`);
    }
    target = selectTestFlightBuild(normalizeBuilds(await buildsRes.json()), { buildNumber });
    if (target || attempt === maxAttempts) {
      break;
    }
    console.log(
      `TestFlight: iOS build ${buildNumber} not indexed yet (attempt ${attempt}/${maxAttempts}); retrying in 20s…`,
    );
    await sleep(20_000);
  }

  if (!target) {
    console.error(
      buildNumber
        ? `Skipping TestFlight: iOS build ${buildNumber} not found for app ${appId} after ${maxAttempts} attempts`
        : "Skipping TestFlight: no iOS builds found",
    );
    return;
  }

  const buildId = target.id;

  // 2. Check if a betaBuildLocalization already exists for en-US
  const locRes = await fetch(
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
    const updateRes = await fetch(`${baseUrl}/betaBuildLocalizations/${existing.id}`, {
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
    const createRes = await fetch(`${baseUrl}/betaBuildLocalizations`, {
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

  console.log(`TestFlight: "What to Test" updated for iOS build ${target.version}`);
}

// --- Main ---

async function main() {
  const { platform, notes, build } = parseArgs(process.argv.slice(2));

  if (!notes) {
    console.error("Error: --notes is required");
    process.exit(1);
  }
  if (!VALID_PLATFORMS.includes(platform)) {
    console.error(`Error: --platform must be one of: ${VALID_PLATFORMS.join(", ")}`);
    process.exit(1);
  }

  const errors = [];

  if (platform === "android" || platform === "all") {
    try {
      await postGooglePlayNotes(notes);
    } catch (err) {
      console.error(`Google Play error: ${err.message}`);
      errors.push(err);
    }
  }

  if (platform === "ios" || platform === "all") {
    try {
      await postTestFlightNotes(notes, build);
    } catch (err) {
      console.error(`TestFlight error: ${err.message}`);
      errors.push(err);
    }
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
