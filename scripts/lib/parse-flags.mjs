// Tiny CLI-flag parser shared by zoho-cli.mjs and state-cli.mjs.
//
// Supports both `--key=value` and `--key value` forms. Throws on missing
// value (e.g. `--key` at end-of-argv) instead of treating the flag as
// boolean — every flag in the support-agent CLIs requires a value, and a
// silent boolean default would make `--body-file --to addr` mis-parse.
//
// Returns `{flags, positional}`:
//   - flags: key-value object of long options (without the leading `--`)
//   - positional: array of non-flag arguments preserving order

export function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const eq = key.indexOf("=");
      if (eq !== -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (i + 1 >= argv.length) {
        throw new Error(`Missing value for --${key}`);
      } else {
        flags[key] = argv[i + 1];
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}
