import { EMAIL_COLORS, escapeHtml, renderEmailLayout, type EmailContent } from "@/lib/email/layout";
import type { HeadlineLine, LimitLine, WeeklyReport } from "@/lib/metrics/weekly-report";
import type { PlatformLimitLevel } from "@/lib/metrics/rpc-schemas";

/**
 * The Monday metrics email (#823): a plain HTML email with a text alternative, laid out
 * from the report model. No images, web fonts or tracking pixels; colours are the design
 * system's status tokens as inline values.
 */

const LEVEL_COLOR: Record<PlatformLimitLevel, string> = {
  ok: EMAIL_COLORS.successText,
  warn: EMAIL_COLORS.warningText,
  critical: EMAIL_COLORS.errorText,
};

const cell = `padding:6px 8px;border-top:1px solid ${EMAIL_COLORS.border};font-size:14px;`;
const numericCell = `${cell}text-align:right;white-space:nowrap;`;
const headCell = `padding:6px 8px;font-size:12px;font-weight:600;color:${EMAIL_COLORS.fgMuted};text-align:left;`;
const numericHeadCell = `${headCell}text-align:right;`;

function heading(text: string): string {
  return `<h2 style="margin:24px 0 8px;font-size:16px;font-weight:700;color:${EMAIL_COLORS.fg};">${escapeHtml(text)}</h2>`;
}

function paragraph(text: string, color: string = EMAIL_COLORS.fg): string {
  return `<p style="margin:0 0 8px;font-size:14px;color:${color};">${escapeHtml(text)}</p>`;
}

interface Column {
  header: string;
  numeric?: boolean;
}

function table(columns: Column[], rows: string[][]): string {
  const head = columns
    .map(
      (c) => `<th style="${c.numeric ? numericHeadCell : headCell}">${escapeHtml(c.header)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (value, i) => `<td style="${columns[i]?.numeric ? numericCell : cell}">${value}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;margin:0 0 8px;"><tr>${head}</tr>${body}</table>`;
}

function levelCell(line: LimitLine): string {
  const stale = line.stale ? " (stale)" : "";
  return `<span style="color:${LEVEL_COLOR[line.level]};font-weight:600;">${escapeHtml(line.level)}</span>${escapeHtml(stale)}`;
}

function limitsTable(lines: LimitLine[]): string {
  return table(
    [
      { header: "Resource" },
      { header: "Used", numeric: true },
      { header: "%", numeric: true },
      { header: "Level" },
    ],
    lines.map((l) => [escapeHtml(l.label), escapeHtml(l.detail), escapeHtml(l.pct), levelCell(l)]),
  );
}

function moreEmptiedNotesText(report: WeeklyReport): string {
  const more = report.needsAttention.moreEmptiedNotes;
  return `…and ${more} more ${more === 1 ? "note" : "notes"}: see ${report.statsUrl}`;
}

function needsAttentionHtml(report: WeeklyReport): string {
  const { needsAttention: na } = report;
  if (na.isClear) {
    return heading("Needs attention") + paragraph("Nothing needs attention.", EMAIL_COLORS.fgMuted);
  }
  const parts: string[] = [];
  if (na.emptiedNotes.length > 0) {
    parts.push(
      paragraph(
        `Notes a single save emptied since ${na.emptiedSince}, still empty 24 hours later:`,
      ),
      table(
        [
          { header: "Emptied (UTC)" },
          { header: "Client" },
          { header: "Characters before", numeric: true },
          { header: "Note ID" },
        ],
        na.emptiedNotes.map((n) => [
          escapeHtml(n.emptiedAt),
          escapeHtml(n.client),
          escapeHtml(n.charsBefore),
          `<code style="font-size:12px;">${escapeHtml(n.noteId)}</code>`,
        ]),
      ),
      ...(na.moreEmptiedNotes > 0 ? [paragraph(moreEmptiedNotesText(report))] : []),
    );
  }
  if (na.limits.length > 0) {
    parts.push(paragraph("Platform limits from 70%:"), limitsTable(na.limits));
  }
  parts.push(...na.notes.map((note) => paragraph(note, EMAIL_COLORS.errorText)));
  return `<div style="margin:24px 0 0;padding:4px 16px 12px;background:${EMAIL_COLORS.warningBg};border-radius:8px;">${heading("Needs attention")}${parts.join("")}</div>`;
}

function headlineRow(line: HeadlineLine): string[] {
  if (line.kind === "text") {
    return [
      escapeHtml(line.label),
      `<span style="color:${EMAIL_COLORS.fgMuted};">${escapeHtml(line.text)}</span>`,
      "",
    ];
  }
  return [escapeHtml(line.label), escapeHtml(line.current), escapeHtml(line.previous)];
}

function headlinesHtml(report: WeeklyReport): string {
  return (
    heading("Headline numbers") +
    table(
      [
        { header: "" },
        { header: "This week", numeric: true },
        { header: "Week before", numeric: true },
      ],
      report.headlines.map(headlineRow),
    )
  );
}

function limitsHtml(report: WeeklyReport): string {
  const { lines, notes } = report.limits;
  return (
    heading("Platform limits") +
    (lines.length > 0
      ? limitsTable(lines)
      : paragraph("No limits reported.", EMAIL_COLORS.fgMuted)) +
    notes.map((note) => paragraph(note, EMAIL_COLORS.errorText)).join("")
  );
}

function headlineText(line: HeadlineLine): string {
  if (line.kind === "text") return `- ${line.label}: ${line.text}`;
  return `- ${line.label}: ${line.current} (week before: ${line.previous})`;
}

function limitText(line: LimitLine): string {
  return `- ${line.label}: ${line.detail} (${line.pct}), ${line.level}${line.stale ? ", stale" : ""}`;
}

function needsAttentionText(report: WeeklyReport): string[] {
  const { needsAttention: na } = report;
  if (na.isClear) return ["NEEDS ATTENTION", "Nothing needs attention."];
  return [
    "NEEDS ATTENTION",
    ...(na.emptiedNotes.length > 0
      ? [
          `Notes a single save emptied since ${na.emptiedSince}, still empty 24 hours later:`,
          ...na.emptiedNotes.map(
            (n) =>
              `- ${n.emptiedAt}, ${n.client}, ${n.charsBefore} characters before, note ${n.noteId}`,
          ),
          ...(na.moreEmptiedNotes > 0 ? [moreEmptiedNotesText(report)] : []),
        ]
      : []),
    ...(na.limits.length > 0 ? ["Platform limits from 70%:", ...na.limits.map(limitText)] : []),
    ...na.notes,
  ];
}

export function weeklyMetricsEmail(report: WeeklyReport): EmailContent {
  const title = `Weekly metrics — ${report.isoWeek}`;
  const bodyHtml = [
    paragraph(
      `The week starting ${report.weekStart}, compared with ${report.previousIsoWeek}.`,
      EMAIL_COLORS.fgMuted,
    ),
    needsAttentionHtml(report),
    headlinesHtml(report),
    limitsHtml(report),
    `<p style="margin:24px 0 0;font-size:14px;"><a href="${escapeHtml(report.statsUrl)}" style="color:${EMAIL_COLORS.primary};text-decoration:underline;">Open /admin/stats</a></p>`,
  ].join("\n");

  const text = [
    title,
    `The week starting ${report.weekStart}, compared with ${report.previousIsoWeek}.`,
    "",
    ...needsAttentionText(report),
    "",
    "HEADLINE NUMBERS",
    ...report.headlines.map(headlineText),
    "",
    "PLATFORM LIMITS",
    ...(report.limits.lines.length > 0
      ? report.limits.lines.map(limitText)
      : ["No limits reported."]),
    ...report.limits.notes,
    "",
    `All metrics: ${report.statsUrl}`,
  ].join("\n");

  return {
    subject: report.subject,
    html: renderEmailLayout({ title: escapeHtml(title), bodyHtml }),
    text,
  };
}
