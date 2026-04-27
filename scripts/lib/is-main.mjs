// Robust "is this module the entry point?" check for ESM scripts.
//
// The naive `import.meta.url === \`file://${process.argv[1]}\`` form fails
// when:
//   - process.argv[1] contains spaces or non-ASCII (template literal doesn't
//     URL-encode them, but import.meta.url is always URL-encoded)
//   - the script is invoked via a symlink (e.g. ~/bin/foo → realpath/foo.mjs)
//   - npx-style shims with realpath resolution are involved
//
// Compare via pathToFileURL(realpathSync(...)).href for a canonical match.
// Returns false if process.argv[1] is undefined (e.g. embedded use).

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // realpathSync throws if the entry script isn't on disk (e.g. piped via
    // `node -e` or evaluated from a buffer). In all such cases this module
    // wasn't invoked as the entry point.
    return false;
  }
}
