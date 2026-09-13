import { escapeAttr, escapeXml } from "./blocknote-to-enml";

export interface ExportedResource {
  /** MD5 hash of the raw resource bytes, lowercase hex. Must match `<en-media hash="…">`. */
  hash: string;
  /** Resource MIME type (e.g. `image/png`). */
  mime: string;
  /** Base64-encoded resource bytes. */
  dataBase64: string;
  /** Original file name shown to the user. */
  fileName: string;
  /** Optional source URL recorded in `<resource-attributes>`. */
  sourceUrl?: string;
}

export interface ExportedNote {
  title: string;
  /** ENML body — the full `<en-note>…</en-note>` fragment for this note. */
  enmlContent: string;
  /** ISO-8601 timestamp; encoded to Evernote `YYYYMMDDTHHMMSSZ` format. */
  created: string;
  /** ISO-8601 timestamp; encoded to Evernote `YYYYMMDDTHHMMSSZ` format. */
  updated: string;
  /** Optional notebook label written to `<note-attributes><notebook>`. */
  notebook?: string;
  resources: ExportedResource[];
}

export interface BuildEnexInput {
  notes: ExportedNote[];
  /** Date stamped on the `<en-export>` envelope; defaults to "now". */
  exportDate?: Date;
  /** Application label written to `<en-export application="…">`. */
  application?: string;
}

const ENEX_DOCTYPE =
  '<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">';
const ENML_DOCTYPE = '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">';
const DEFAULT_APPLICATION = "Drafto";

export function buildEnex({ notes, exportDate, application }: BuildEnexInput): string {
  const stamp = formatEvernoteDate(exportDate ?? new Date());
  const app = escapeAttr(application ?? DEFAULT_APPLICATION);
  const noteXml = notes.map(noteToXml).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    ENEX_DOCTYPE +
    `<en-export export-date="${stamp}" application="${app}" version="10.0">` +
    noteXml +
    "</en-export>"
  );
}

function noteToXml(note: ExportedNote): string {
  const title = escapeXml(note.title || "Untitled");
  const created = formatEvernoteDate(note.created);
  const updated = formatEvernoteDate(note.updated);
  const content = wrapEnmlBody(note.enmlContent);
  const notebookTag = note.notebook ? `<notebook>${escapeXml(note.notebook)}</notebook>` : "";
  const attributes = `<note-attributes><source>drafto</source>${notebookTag}</note-attributes>`;
  const resources = note.resources.map(resourceToXml).join("");
  return (
    "<note>" +
    `<title>${title}</title>` +
    `<content><![CDATA[${content}]]></content>` +
    `<created>${created}</created>` +
    `<updated>${updated}</updated>` +
    attributes +
    resources +
    "</note>"
  );
}

function resourceToXml(resource: ExportedResource): string {
  const fileName = escapeXml(resource.fileName || "attachment");
  const mime = escapeXml(resource.mime || "application/octet-stream");
  const attrs =
    `<resource-attributes>` +
    `<file-name>${fileName}</file-name>` +
    (resource.sourceUrl ? `<source-url>${escapeXml(resource.sourceUrl)}</source-url>` : "") +
    `</resource-attributes>`;
  return (
    "<resource>" +
    `<data encoding="base64">${resource.dataBase64}</data>` +
    `<mime>${mime}</mime>` +
    attrs +
    "</resource>"
  );
}

function wrapEnmlBody(enml: string): string {
  const trimmed = enml.trim();
  // Strip any leading XML declaration / DOCTYPE / existing en-note wrapper so we
  // can emit a canonical envelope. `<en-note>` is required by Evernote; the
  // import side is fine with whitespace inside CDATA.
  const withoutDecl = trimmed
    .replace(/^<\?xml[^>]*\?>\s*/i, "")
    .replace(/^<!DOCTYPE[^>]*>\s*/i, "");
  const hasWrapper = /^<en-note(\s|>)/i.test(withoutDecl);
  const body = hasWrapper ? withoutDecl : `<en-note>${withoutDecl}</en-note>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' + ENML_DOCTYPE + body;
}

/**
 * Format an ISO-8601 timestamp or `Date` as Evernote's `YYYYMMDDTHHMMSSZ`.
 * Falls back to "now" for invalid input rather than throwing — the export
 * should never fail because a single timestamp went sideways.
 */
export function formatEvernoteDate(input: string | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const iso = safe.toISOString(); // 2026-06-08T15:06:32.056Z
  return (
    iso.slice(0, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    "T" +
    iso.slice(11, 13) +
    iso.slice(14, 16) +
    iso.slice(17, 19) +
    "Z"
  );
}
