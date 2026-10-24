import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateRawSync } from "node:zlib";
import { findCredentials, readZipEntries, scanReport } from "../scan-playwright-report.mjs";

const SCRIPT = fileURLToPath(new URL("../scan-playwright-report.mjs", import.meta.url));
const PASSWORD = "fixture-pass-9001";
const SECRETS = [{ name: "E2E_TEST_PASSWORD", value: PASSWORD }];
const COOKIE_HEADER = '{"name":"Cookie","value":"sb-abcdefgh-auth-token=base64-eyJ"}';

/** A minimal zip with no CRCs, which the reader doesn't check. */
function makeZip(entries, method = 8) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuffer = Buffer.from(name);
    const raw = Buffer.from(data);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, nameBuffer, body);
    central.push(header, nameBuffer);
    offset += local.length + nameBuffer.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** An index.html that inlines its report data the way Playwright's does. */
function htmlReport(reportJson) {
  const zip = makeZip([{ name: "report.json", data: reportJson }]);
  return `<html><script>window.playwrightReportBase64 = "data:application/zip;base64,${zip.toString("base64")}";</script></html>`;
}

let tmp;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scan-playwright-report-"));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function makeReport(name, files) {
  const root = path.join(tmp, name);
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
}

describe("readZipEntries", () => {
  it("reads deflated and stored entries", () => {
    for (const method of [0, 8]) {
      const entries = readZipEntries(
        makeZip(
          [
            { name: "a.json", data: '{"a":1}' },
            { name: "dir/b.txt", data: "bee" },
          ],
          method,
        ),
      );
      assert.deepEqual(
        entries.map(({ name, data }) => [name, data.toString()]),
        [
          ["a.json", '{"a":1}'],
          ["dir/b.txt", "bee"],
        ],
      );
    }
  });

  it("throws on something that isn't a zip", () => {
    assert.throws(() => readZipEntries(Buffer.from("not a zip at all")), /not a zip archive/);
  });

  it("throws on an entry that runs past the end of the archive", () => {
    const zip = makeZip([{ name: "a.json", data: '{"a":1}' }], 0);
    const directory = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE(1_000_000, directory + 20); // claim a far larger entry
    assert.throws(() => readZipEntries(zip), /truncated entry a\.json/);
  });
});

describe("findCredentials", () => {
  it("finds a secret value, raw, JSON-escaped or URL-encoded", () => {
    assert.deepEqual(findCredentials(`Fill "${PASSWORD}"`, SECRETS), ["E2E_TEST_PASSWORD"]);
    const quoted = [{ name: "E2E_ADMIN_PASSWORD", value: 'pa"ss\\word' }];
    assert.deepEqual(findCredentials(JSON.stringify({ title: 'Fill "pa"ss\\word"' }), quoted), [
      "E2E_ADMIN_PASSWORD",
    ]);
    const spaced = [{ name: "E2E_TEST_PASSWORD", value: "p@ss w/rd" }];
    assert.deepEqual(findCredentials(`?password=${encodeURIComponent("p@ss w/rd")}`, spaced), [
      "E2E_TEST_PASSWORD",
    ]);
  });

  it("finds session tokens by shape, escaped or not", () => {
    assert.deepEqual(findCredentials(COOKIE_HEADER, []), ["supabase-auth-cookie"]);
    // report.json stores stdout and errors as JSON strings, escaping the quotes
    const logged = JSON.stringify(JSON.stringify({ refresh_token: "rt-123" }));
    assert.deepEqual(findCredentials(logged, []), ["oauth-token"]);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl";
    assert.deepEqual(findCredentials(`authorization: Bearer ${jwt}`, []), ["jwt", "bearer"]);
  });

  it("finds nothing in a clean report", () => {
    assert.deepEqual(findCredentials("Fill \"Groceries\" getByLabel('Title')", SECRETS), []);
  });
});

describe("scanReport", () => {
  it("passes a clean report", async () => {
    const dir = await makeReport("clean", {
      "index.html": htmlReport('{"title":"Fill \\"Groceries\\""}'),
      "data/abc.md": '- textbox "Password"\n- button "Log in"',
    });
    assert.deepEqual(await scanReport(dir, SECRETS), []);
  });

  it("finds a password in a step title inside the inlined report zip", async () => {
    const dir = await makeReport("step-title", {
      "index.html": htmlReport(JSON.stringify({ title: `Fill "${PASSWORD}"` })),
    });
    assert.deepEqual(await scanReport(dir, SECRETS), [
      { file: "index.html#embedded!report.json", found: ["E2E_TEST_PASSWORD"] },
    ]);
  });

  it("finds a password in a failure snapshot", async () => {
    const dir = await makeReport("snapshot", {
      "data/abc.md": `- textbox "Password": ${PASSWORD}`,
    });
    assert.deepEqual(await scanReport(dir, SECRETS), [
      { file: "data/abc.md", found: ["E2E_TEST_PASSWORD"] },
    ]);
  });

  it("finds a session cookie inside a trace archive", async () => {
    const dir = await makeReport("trace", {
      "data/trace.zip": makeZip([{ name: "0-trace.network", data: COOKIE_HEADER }]),
    });
    assert.deepEqual(await scanReport(dir, SECRETS), [
      { file: "data/trace.zip!0-trace.network", found: ["supabase-auth-cookie"] },
    ]);
  });

  it("fails closed on an archive it can't read", async () => {
    const dir = await makeReport("corrupt", { "data/trace.zip": "garbage" });
    const [finding] = await scanReport(dir, SECRETS);
    assert.equal(finding.file, "data/trace.zip");
    assert.match(finding.found[0], /^unreadable archive/);
  });

  it("fails closed on a symlink, which the upload would follow", async () => {
    const outside = await makeReport("symlink-target", { "secret.txt": PASSWORD });
    const dir = await makeReport("symlink", { "index.html": "<html></html>" });
    await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "linked.txt"));
    assert.deepEqual(await scanReport(dir, SECRETS), [
      { file: "linked.txt", found: ["not a regular file (symlink or special file)"] },
    ]);
  });
});

describe("CLI", () => {
  const run = (dir, env) =>
    promisify(execFile)(process.execPath, [SCRIPT, dir], {
      env: { PATH: process.env.PATH, ...env },
    });

  it("exits 1 and names the file and variable, never the value", async () => {
    const dir = await makeReport("cli-leak", {
      "data/abc.md": `- textbox "Password": ${PASSWORD}`,
    });
    await assert.rejects(run(dir, { E2E_TEST_PASSWORD: PASSWORD }), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /data\/abc\.md: E2E_TEST_PASSWORD/);
      assert.ok(!`${err.stdout}${err.stderr}`.includes(PASSWORD));
      return true;
    });
  });

  it("exits 0 for a clean report and for a missing one", async () => {
    const dir = await makeReport("cli-clean", { "data/abc.md": "- button" });
    assert.match((await run(dir, { E2E_TEST_PASSWORD: PASSWORD })).stdout, /No credentials found/);
    assert.match((await run(path.join(tmp, "absent"), {})).stdout, /nothing to scan/);
  });

  it("exits 1 when the report path exists but isn't a directory", async () => {
    const dir = await makeReport("cli-not-dir", { "report.txt": "x" });
    await assert.rejects(run(path.join(dir, "report.txt"), {}), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /is not a directory/);
      return true;
    });
  });
});
