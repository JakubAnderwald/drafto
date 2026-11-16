#!/usr/bin/env node
// The size marker of a factory plan (ADR-0083), for factory-agent.sh's
// plan_size_label: reads a plan comment body on stdin and prints
// parsePlanSize's result as one JSON line, {"sizeClass","estLines"} or null.
// Bash compares estLines with FACTORY_PLAN_OVERSIZE_LINES to keep the
// factory-oversize label in step.
//
// CLI: node plan-size.mjs < body   (exit 0; 1 when stdin can't be read)

import { readFileSync } from "node:fs";

import { parsePlanSize } from "./factory-bundle.mjs";
import { isMainModule } from "./is-main.mjs";

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(parsePlanSize(readFileSync(0, "utf8")))}\n`);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exitCode = 1;
  }
}
