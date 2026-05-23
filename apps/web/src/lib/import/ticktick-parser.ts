import type { TickTickGroup, TickTickItem } from "@/lib/import/ticktick-types";

const REQUIRED_COLUMNS = ["List Name", "Title"] as const;

export function parseTickTickCsv(csv: string): TickTickGroup[] {
  const rows = parseCsvRows(csv);
  if (rows.length === 0) {
    throw new Error("Invalid TickTick export: file is empty");
  }

  const headerIndex = rows.findIndex(isHeaderRow);
  if (headerIndex === -1) {
    throw new Error("Invalid TickTick export: header row not found");
  }

  const header = rows[headerIndex];
  const columnIndex = new Map<string, number>();
  header.forEach((name, idx) => columnIndex.set(name.trim(), idx));

  for (const required of REQUIRED_COLUMNS) {
    if (!columnIndex.has(required)) {
      throw new Error(`Invalid TickTick export: missing "${required}" column`);
    }
  }

  const dataRows = rows.slice(headerIndex + 1).filter((row) => row.some((cell) => cell !== ""));
  const groups = new Map<string, TickTickGroup>();

  for (const row of dataRows) {
    const item = rowToItem(row, columnIndex);
    if (!item) continue;
    const key = item.folderName ? `${item.folderName} / ${item.listName}` : item.listName;
    const notebookName = key || "TickTick Import";
    const group = groups.get(notebookName);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(notebookName, { notebookName, items: [item] });
    }
  }

  return Array.from(groups.values());
}

function isHeaderRow(row: string[]): boolean {
  return row.includes("List Name") && row.includes("Title");
}

function rowToItem(row: string[], columnIndex: Map<string, number>): TickTickItem | null {
  const get = (name: string): string => {
    const idx = columnIndex.get(name);
    if (idx === undefined) return "";
    return row[idx]?.trim() ?? "";
  };

  const title = get("Title");
  if (!title) return null;

  const isCheckList =
    parseBoolean(get("Is Check list")) || get("Kind").toUpperCase() === "CHECKLIST";
  const created = parseTickTickDate(get("Created Time"));
  const modifiedRaw = get("Modified Time");
  const updated = modifiedRaw ? parseTickTickDate(modifiedRaw) : created;

  return {
    folderName: get("Folder Name"),
    listName: get("List Name") || "Inbox",
    title,
    content: get("Content"),
    isCheckList,
    created,
    updated,
  };
}

function parseBoolean(value: string): boolean {
  const v = value.trim().toUpperCase();
  return v === "Y" || v === "YES" || v === "TRUE" || v === "1";
}

function parseTickTickDate(value: string): string {
  if (!value) return new Date().toISOString();
  const trimmed = value.trim();
  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const normalised = trimmed.replace(" ", "T");
  const fallback = new Date(normalised);
  if (!Number.isNaN(fallback.getTime())) return fallback.toISOString();
  return new Date().toISOString();
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const text = input.replace(/^﻿/, "");

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }

    if (ch === "\r") {
      i++;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
