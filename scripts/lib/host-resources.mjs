// Host resource probes shared by the factory's detached lanes: the
// verification shell lane (verify-lane.mjs) and detached --implement runs
// (implement-lane.mjs, ADR-0085). Moved here unchanged from verify-lane.mjs's
// createDeps(); both fail open (null) when the value can't be read.

import { execFile } from "node:child_process";

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8" }, (err, stdout) => {
      if (err) {
        resolve({ code: typeof err.code === "number" ? err.code : 127, stdout: stdout ?? "" });
        return;
      }
      resolve({ code: 0, stdout: stdout ?? "" });
    });
  });
}

// macOS: 1 normal, 2 warn, 4 critical. null when it can't be read (fail open).
export async function memoryPressure({ exec = run } = {}) {
  const r = await exec("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isInteger(n) ? n : null;
}

// Whole GiB free on <dir>'s volume, or null.
export async function freeDiskGb(dir, { exec = run } = {}) {
  const r = await exec("df", ["-Pk", dir]);
  const row = r.code === 0 ? r.stdout.trim().split("\n")[1] : "";
  const kb = Number(row?.split(/\s+/)[3]);
  return Number.isFinite(kb) ? Math.floor(kb / 1024 / 1024) : null;
}
