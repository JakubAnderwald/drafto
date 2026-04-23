#!/usr/bin/env node
/**
 * Post release notes to Google Play and/or App Store Connect (TestFlight).
 *
 * Usage:
 *   node post-release-notes.mjs --platform android|ios|all --notes "Release notes text"
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

const args = process.argv.slice(2);
const platformIdx = args.indexOf("--platform");
const notesIdx = args.indexOf("--notes");
const platform = platformIdx !== -1 ? args[platformIdx + 1] : "all";
const notes = notesIdx !== -1 ? args[notesIdx + 1] : "";

if (!notes) {
  console.error("Error: --notes is required");
  process.exit(1);
}

const validPlatforms = ["android", "ios", "all"];
if (!validPlatforms.includes(platform)) {
  console.error(`Error: --platform must be one of: ${validPlatforms.join(", ")}`);
  process.exit(1);
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

  const appId = process.env.ASC_APP_ID || "6760675784";
  const jwt = generateAscJwt(keyId, issuerId, privateKeyP8);
  const baseUrl = "https://api.appstoreconnect.apple.com/v1";
  const headers = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };

  // 1. Find the latest build (most recent preReleaseVersion).
  // Uses the top-level /v1/builds endpoint because the relationship endpoint /v1/apps/{id}/builds
  // no longer accepts the `sort` query parameter.
  const buildsRes = await fetch(
    `${baseUrl}/builds?filter[app]=${appId}&sort=-uploadedDate&limit=1&fields[builds]=version,processingState`,
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

  const buildId = buildsData.data[0].id;

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

  console.log(
    `TestFlight: "What to Test" updated for build ${buildsData.data[0].attributes.version}`,
  );
}

// --- Main ---

async function main() {
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
      await postTestFlightNotes(notes);
    } catch (err) {
      console.error(`TestFlight error: ${err.message}`);
      errors.push(err);
    }
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

main();
