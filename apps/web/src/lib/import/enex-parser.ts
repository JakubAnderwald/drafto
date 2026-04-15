import type { EnexNote, EnexResource, EnexTask } from "@/lib/import/types";

/**
 * Parse an Evernote .enex XML string into structured notes.
 * Uses the browser DOMParser (client-side only).
 */
export function parseEnexFile(xmlString: string): EnexNote[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error("Invalid .enex file: XML parsing failed");
  }

  const noteElements = doc.querySelectorAll("note");
  const notes: EnexNote[] = [];

  for (const noteEl of noteElements) {
    notes.push(parseNoteElement(noteEl));
  }

  return notes;
}

function parseNoteElement(noteEl: Element): EnexNote {
  const title = noteEl.querySelector("title")?.textContent?.trim() || "Untitled";
  const content = noteEl.querySelector("content")?.textContent?.trim() || "";
  const created = parseEnexTimestamp(noteEl.querySelector("created")?.textContent || "");
  const updated = parseEnexTimestamp(noteEl.querySelector("updated")?.textContent || created);

  const resourceElements = noteEl.querySelectorAll("resource");
  const resources: EnexResource[] = [];

  for (const resEl of resourceElements) {
    const resource = parseResourceElement(resEl);
    if (resource) {
      resources.push(resource);
    }
  }

  const taskElements = noteEl.querySelectorAll("task");
  const tasks: EnexTask[] = [];

  for (const taskEl of taskElements) {
    const task = parseTaskElement(taskEl);
    if (task) {
      tasks.push(task);
    }
  }

  return { title, content, created, updated, resources, tasks };
}

function parseTaskElement(taskEl: Element): EnexTask | null {
  const title = taskEl.querySelector("title")?.textContent?.trim() || "";
  if (!title) return null;

  const taskStatus = taskEl.querySelector("taskStatus")?.textContent?.trim() || "";
  const checked = taskStatus === "completed";
  const groupId = taskEl.querySelector("taskGroupNoteLevelID")?.textContent?.trim() || "";
  const sortWeight = taskEl.querySelector("sortWeight")?.textContent?.trim() || undefined;

  return { title, checked, groupId, sortWeight };
}

function parseResourceElement(resEl: Element): EnexResource | null {
  const dataEl = resEl.querySelector("data");
  const data = dataEl?.textContent?.replace(/\s/g, "") || "";
  if (!data) return null;

  const mime = resEl.querySelector("mime")?.textContent?.trim() || "application/octet-stream";

  // Hash from recognition or resource-attributes
  const hash =
    resEl.querySelector("recognition")?.textContent?.match(/hash="([^"]+)"/)?.[1] ||
    resEl.querySelector("resource-attributes > source-url")?.textContent?.trim() ||
    generateSimpleHash(data);

  const fileName =
    resEl.querySelector("resource-attributes > file-name")?.textContent?.trim() ||
    `attachment.${mimeToExtension(mime)}`;

  return { data, mime, hash, fileName };
}

/**
 * Parse Evernote timestamp format (YYYYMMDDTHHmmssZ) to ISO string.
 */
function parseEnexTimestamp(ts: string): string {
  if (!ts) return new Date().toISOString();

  // Evernote format: 20230415T120000Z
  const match = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`).toISOString();
  }

  // Try ISO format directly
  const date = new Date(ts);
  if (!isNaN(date.getTime())) {
    return date.toISOString();
  }

  return new Date().toISOString();
}

function mimeToExtension(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  };
  return map[mime] || "bin";
}

/**
 * Generate a simple hash from base64 data for en-media matching.
 * Not cryptographic — just enough to match resources to en-media tags.
 */
function generateSimpleHash(data: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(data.length, 1000); i++) {
    hash = (hash * 31 + data.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}
