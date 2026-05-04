#!/usr/bin/env node
// One-shot backfill: download the two screenshots from the Zoho email that
// produced issue #360, upload them to support-attachments/, and edit the
// issue body to embed them inline.
//
// Background: issue #360 was filed before the realtime support agent could
// fetch attachments — the body acknowledges "two screenshots" in prose but
// the binaries never made it onto the issue. After this PR lands the
// realtime path handles attachments natively (scripts/lib/zoho-cli.mjs +
// support-agent.sh + support-agent-prompt.md). This script bridges the
// pre-fix gap for #360 specifically; it is deleted in the same PR.
//
// Usage (run on the Mac mini, where Zoho OAuth + gh CLI are already set up):
//   node scripts/backfill-issue-360-attachments.mjs
//
// Idempotent: re-running is safe — the GitHub upload uses 409→GET-sha→re-PUT
// recovery, and the issue-body edit only inserts the attachment block once
// (it bails out if the body already contains the marker line).
//
// Search strategy: Zoho's /messages/search endpoint is finicky about the
// query format, so we use /messages/view with a folderId scan and filter
// in Node. The original message lives in Inbox or a Drafto/Support/* folder
// depending on whether the agent moved it.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, getAccessToken, invalidateAccessToken } from "./lib/zoho-auth.mjs";
import { getAttachmentInfo, downloadAttachment } from "./lib/zoho-cli.mjs";

const execFileP = promisify(execFile);

const ISSUE_NUMBER = 360;
const REPO = "JakubAnderwald/drafto";
const SUBJECT_NEEDLE = "collapsing notebook bar";
const SENDER_NEEDLE = "jakub@anderwald.info";
const ATTACHMENTS_DIR = "support-attachments";
const MARKER = "**Attachments:**";

async function zohoGet(urlPath, query) {
  const cfg = await loadConfig();
  const url = new URL(`https://${cfg.mailHost}${urlPath}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  let token = await getAccessToken();
  let res = await fetch(url.toString(), { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (res.status === 401) {
    invalidateAccessToken();
    token = await getAccessToken();
    res = await fetch(url.toString(), { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Zoho GET ${urlPath} failed: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Walk every folder until we find the inbound message that produced #360.
async function findSourceMessage() {
  const cfg = await loadConfig();
  const folders = await zohoGet(`/api/accounts/${cfg.accountId}/folders`);
  const folderEntries = (folders.data ?? []).filter((f) => {
    const name = f.folderName ?? f.name ?? "";
    // Inbox, Drafto/Support/Resolved, and any other support folder are all
    // candidates — Zoho doesn't tell us up-front which one the agent moved
    // the thread to, so scan everything that could legitimately hold it.
    return name === "Inbox" || name.startsWith("Drafto/Support/");
  });
  for (const folder of folderEntries) {
    const folderId = folder.folderId ?? folder.id;
    const folderName = folder.folderName ?? folder.name;
    if (!folderId) continue;
    let start = 1;
    const PAGE = 200;
    // Page forward until a page returns fewer than PAGE entries.
    while (true) {
      const page = await zohoGet(`/api/accounts/${cfg.accountId}/messages/view`, {
        folderId,
        start,
        limit: PAGE,
        includeto: "true",
      });
      const arr = page.data ?? page.messages ?? [];
      if (!Array.isArray(arr) || arr.length === 0) break;
      for (const m of arr) {
        const subj = String(m.subject ?? "").toLowerCase();
        const from = String(m.fromAddress ?? m.sender ?? "").toLowerCase();
        if (subj.includes(SUBJECT_NEEDLE) && from.includes(SENDER_NEEDLE)) {
          console.log(`Found source message in folder "${folderName}":`);
          console.log(`  messageId=${m.messageId}  folderId=${m.folderId ?? folderId}`);
          console.log(`  subject="${m.subject}"  from=${m.fromAddress}`);
          return { messageId: m.messageId, folderId: m.folderId ?? folderId, raw: m };
        }
      }
      if (arr.length < PAGE) break;
      start += PAGE;
    }
  }
  throw new Error(`Could not locate the source email for issue #${ISSUE_NUMBER} in any folder`);
}

function safeName(name) {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return cleaned || "attachment";
}

function timestampFrom(rawMessage) {
  // Zoho's /messages/view returns receivedTime as a millisecond epoch string.
  // Fall back to current UTC if absent.
  const ms = Number(rawMessage.receivedTime);
  const d = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date();
  return d
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
}

async function ghApi(args, { input } = {}) {
  // gh api swallows stderr on non-2xx by exiting non-zero; surface both
  // streams so failures aren't silent.
  try {
    const { stdout } = await execFileP("gh", args, {
      maxBuffer: 64 * 1024 * 1024,
      input,
    });
    return stdout;
  } catch (err) {
    const msg = err.stderr?.toString() ?? err.message;
    err.message = `gh ${args.join(" ")} failed: ${msg}`;
    throw err;
  }
}

async function uploadToContents(repoPath, localPath, message) {
  const bytes = await fs.readFile(localPath);
  const content = bytes.toString("base64");
  // First attempt: create. If the path already exists (409), GET to recover
  // the SHA, then re-PUT with the SHA to overwrite.
  const putArgs = (sha) => {
    const a = [
      "api",
      "-X",
      "PUT",
      `/repos/${REPO}/contents/${repoPath}`,
      "-f",
      `message=${message}`,
      "-f",
      `content=${content}`,
    ];
    if (sha) a.push("-f", `sha=${sha}`);
    return a;
  };
  try {
    const out = await ghApi(putArgs(null));
    return JSON.parse(out);
  } catch (err) {
    if (
      !String(err.message).includes('"sha" wasn\'t supplied') &&
      !String(err.message).includes("HTTP 422")
    ) {
      throw err;
    }
    const meta = await ghApi(["api", `/repos/${REPO}/contents/${repoPath}`]);
    const sha = JSON.parse(meta).sha;
    const out = await ghApi(putArgs(sha));
    return JSON.parse(out);
  }
}

async function patchIssueBody(issueNumber, attachmentMarkdown) {
  const bodyRaw = await ghApi(["api", `/repos/${REPO}/issues/${issueNumber}`, "--jq", ".body"]);
  const body = bodyRaw.replace(/\n+$/, "");
  if (body.includes(MARKER)) {
    console.log(`Issue #${issueNumber} body already contains "${MARKER}" — skipping body edit.`);
    return false;
  }
  // The agent footer is an HTML comment block beginning with `<!-- drafto-support-agent`.
  // Insert the attachments block immediately before that footer so the parser
  // (parse-issue-footer.mjs) still finds the footer at the end.
  const footerIdx = body.indexOf("<!-- drafto-support-agent");
  let updated;
  if (footerIdx === -1) {
    updated = `${body}\n${attachmentMarkdown}\n`;
  } else {
    const before = body.slice(0, footerIdx).replace(/\n+$/, "");
    const after = body.slice(footerIdx);
    updated = `${before}\n\n${attachmentMarkdown}\n\n${after}`;
  }
  // gh api -F body=<value> reads the value from a file; pass via stdin instead.
  const payload = JSON.stringify({ body: updated });
  await ghApi(["api", "-X", "PATCH", `/repos/${REPO}/issues/${issueNumber}`, "--input", "-"], {
    input: payload,
  });
  console.log(`Patched issue #${issueNumber} body (added attachments block).`);
  return true;
}

async function main() {
  console.log(`Backfilling issue #${ISSUE_NUMBER} attachments from Zoho.`);
  const source = await findSourceMessage();
  const meta = await getAttachmentInfo(source.folderId, source.messageId);
  if (meta.length === 0) {
    console.log("No attachments on the source message — nothing to backfill.");
    return;
  }
  console.log(`Source has ${meta.length} attachment(s):`);
  for (const a of meta)
    console.log(`  - ${a.filename} (${a.size} B${a.isInline ? ", inline" : ""})`);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drafto-backfill-360-"));
  console.log(`Tmp dir: ${tmpDir}`);

  // Wrap the whole download/upload/patch flow in try/finally so the tmpDir is
  // reaped even on partial failure. The downloads are customer attachments
  // (PII potentially), so leaving them in /tmp across runs is sloppy.
  try {
    const ts = timestampFrom(source.raw);
    const lines = ["", "---", "", MARKER, ""];
    let written = 0;
    for (const [idx, att] of meta.entries()) {
      const sName = safeName(att.filename);
      const localPath = path.join(tmpDir, `${idx}-${sName}`);
      let downloaded;
      try {
        downloaded = await downloadAttachment(source.folderId, source.messageId, att.attachmentId, {
          out: localPath,
        });
      } catch (err) {
        console.error(`download failed for ${att.filename}: ${err.message}`);
        lines.push(`Failed to download: ${att.filename}`);
        continue;
      }
      const repoPath = `${ATTACHMENTS_DIR}/${ts}-${sName}`;
      let uploaded;
      try {
        uploaded = await uploadToContents(
          repoPath,
          localPath,
          `chore: backfill support attachment ${sName} (issue #${ISSUE_NUMBER})`,
        );
      } catch (err) {
        console.error(`upload failed for ${att.filename}: ${err.message}`);
        lines.push(`Failed to upload: ${att.filename}`);
        continue;
      }
      const downloadUrl = uploaded?.content?.download_url ?? uploaded?.download_url;
      if (!downloadUrl) {
        console.error(`upload returned no download_url for ${att.filename}`);
        lines.push(`Failed to upload: ${att.filename} (no download_url returned)`);
        continue;
      }
      const isImage = (downloaded.contentType ?? "").startsWith("image/");
      lines.push(
        isImage ? `![${att.filename}](${downloadUrl})` : `[${att.filename}](${downloadUrl})`,
      );
      lines.push("");
      written += 1;
      console.log(`Uploaded ${att.filename} → ${repoPath}`);
    }

    if (written === 0) {
      console.log("No attachments uploaded successfully — leaving issue body untouched.");
      return;
    }

    await patchIssueBody(ISSUE_NUMBER, lines.join("\n").replace(/\n+$/, ""));
    console.log(
      `Done. ${written}/${meta.length} attachment(s) backfilled to issue #${ISSUE_NUMBER}.`,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
