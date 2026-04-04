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

async function postTestFlightNotes(releaseNotes) {
  const keyId = process.env.ASC_API_KEY_ID;
  const issuerId = process.env.ASC_API_ISSUER_ID;
  const privateKeyP8 =
    process.env.ASC_API_KEY_P8 ||
    (() => {
      try {
        return readFileSync("appstore-api-key.p8", "utf-8");
      } catch {
        return null;
      }
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

  // 1. Find the latest build (most recent preReleaseVersion)
  const buildsRes = await fetch(
    `${baseUrl}/apps/${appId}/builds?sort=-uploadedDate&limit=1&fields[builds]=version,processingState`,
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
  try {
    await postTestFlightNotes(notes);
  } catch (err) {
    console.error(`TestFlight error: ${err.message}`);
    process.exit(1);
  }
}

main();
