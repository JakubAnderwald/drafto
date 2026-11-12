// Runs supabase/migrations/20261112000001_note_text_chars.sql, verbatim, in
// PGlite (Postgres compiled to WASM, in process) and checks what
// public.note_text_chars counts. The product metrics (ADR 0075) count a note
// version as writing by this number, so a double count (lax `.**`) or a missed
// nesting level would skew every metric.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATION = path.join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20261112000001_note_text_chars.sql",
);

let db;

async function chars(content) {
  const res = await db.query("select public.note_text_chars($1::jsonb) as n", [
    content === null ? null : JSON.stringify(content),
  ]);
  return res.rows[0].n;
}

const text = (t, styles = {}) => ({ type: "text", text: t, styles });

describe("note_text_chars (PGlite)", () => {
  before(async () => {
    db = new PGlite();
    // The Supabase API roles the migration revokes from and grants to.
    await db.exec("create role anon; create role authenticated; create role service_role;");
    await db.exec(readFileSync(MIGRATION, "utf8"));
  });

  after(async () => {
    await db?.close();
  });

  it("counts null content, and content with no text, as 0", async () => {
    assert.equal(await chars(null), 0);
    assert.equal(await chars([]), 0);
    assert.equal(await chars({ type: "doc", content: [] }), 0);
    // SQL NULL and JSON null alike.
    const res = await db.query("select public.note_text_chars('null'::jsonb) as n");
    assert.equal(res.rows[0].n, 0);
  });

  it("counts an empty paragraph as 0, in BlockNote and TipTap shapes", async () => {
    assert.equal(
      await chars([{ id: "a", type: "paragraph", props: {}, content: [], children: [] }]),
      0,
    );
    assert.equal(await chars({ type: "doc", content: [{ type: "paragraph" }] }), 0);
    // An empty text run is zero characters, not one item.
    assert.equal(await chars([{ type: "paragraph", content: [text("")] }]), 0);
  });

  it("sums text in nested BlockNote children, links and table cells", async () => {
    const content = [
      {
        id: "1",
        type: "heading",
        props: { level: 1, textColor: "default" },
        content: [text("Title")], // 5
        children: [
          {
            id: "2",
            type: "bulletListItem",
            props: {},
            content: [
              text("one"),
              { type: "link", href: "https://x.test/text", content: [text("two")] },
            ], // 6
            children: [
              {
                id: "3",
                type: "paragraph",
                props: {},
                content: [text("deep")], // 4
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: "4",
        type: "table",
        props: {},
        content: {
          type: "tableContent",
          rows: [
            { cells: [[text("ab")], { type: "tableCell", props: {}, content: [text("cde")] }] }, // 5
          ],
        },
        children: [],
      },
    ];
    assert.equal(await chars(content), 5 + 6 + 4 + 5);
  });

  it("sums text in a TipTap list, ignoring attrs", async () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "first item" }] }], // 10
            },
            {
              type: "listItem",
              attrs: { checked: false },
              content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }], // 6
            },
          ],
        },
      ],
    };
    assert.equal(await chars(doc), 10 + 6);
  });

  it("counts text with marks and styles once, and characters, not bytes", async () => {
    const tiptap = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }, { type: "italic" }] }, // 4
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://x.test" } }],
            }, // 4
          ],
        },
      ],
    };
    assert.equal(await chars(tiptap), 4 + 4);
    const blocknote = [
      {
        type: "paragraph",
        content: [text("żółć", { bold: true, italic: true }), text(" ✓", { code: true })],
      },
    ];
    assert.equal(await chars(blocknote), 4 + 2);
  });

  it("ignores text keys whose value isn't a string", async () => {
    assert.equal(
      await chars([{ type: "paragraph", content: [{ type: "text", text: 42 }, text("ok")] }]),
      2,
    );
    assert.equal(await chars({ text: { text: "inner" } }), 5);
  });

  it("is immutable, invoker, with a pinned search_path", async () => {
    const res = await db.query(
      `select p.provolatile, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'note_text_chars'`,
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].provolatile, "i");
    assert.equal(res.rows[0].prosecdef, false);
    assert.deepEqual(res.rows[0].proconfig, ["search_path=public, pg_catalog"]);
  });

  it("is executable by service_role only", async () => {
    for (const [role, allowed] of [
      ["public", false],
      ["anon", false],
      ["authenticated", false],
      ["service_role", true],
    ]) {
      const res = await db.query(
        role === "public"
          ? `select exists (
               select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.proname = 'note_text_chars' and a.grantee = 0 and a.privilege_type = 'EXECUTE'
             ) as ok`
          : `select has_function_privilege('${role}', 'public.note_text_chars(jsonb)', 'execute') as ok`,
      );
      assert.equal(res.rows[0].ok, allowed, role);
    }
  });
});
