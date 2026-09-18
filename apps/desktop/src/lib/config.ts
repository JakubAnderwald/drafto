/**
 * App configuration.
 *
 * Uses react-native-dotenv to load environment variables at build time:
 * - Debug builds: read from `.env` (dev Supabase project)
 * - Release builds: Fastlane injects `.env.production` into the environment before
 *   bundling; react-native-dotenv gives `process.env` precedence over the `.env` file,
 *   so the prod values win (same approach as mobile's Fastlane lane).
 *
 * `API_URL` is the origin of the Drafto web API, which the app calls for work that needs
 * the server (account deletion: `DELETE /api/account`). Set it in `.env` (dev web URL) and
 * `.env.production`. When it is absent — including Jest/CI, which have no `.env` file
 * (`allowUndefined` inlines `undefined`) — it falls back to the canonical prod host. Use the
 * apex `https://drafto.eu`, not `www`: a cross-host redirect drops the `Authorization` header.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, API_URL } from "@env";

export const supabaseUrl = SUPABASE_URL;
export const supabaseAnonKey = SUPABASE_ANON_KEY;
export const apiUrl = API_URL || "https://drafto.eu";
