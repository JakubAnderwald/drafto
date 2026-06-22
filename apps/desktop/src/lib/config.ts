/**
 * App configuration.
 *
 * Uses react-native-dotenv to load environment variables at build time:
 * - Debug builds: read from `.env` (dev Supabase project)
 * - Release builds: Fastlane injects `.env.production` into the environment before
 *   bundling; react-native-dotenv gives `process.env` precedence over the `.env` file,
 *   so the prod values win (same approach as mobile's Fastlane lane).
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@env";

export const supabaseUrl = SUPABASE_URL;
export const supabaseAnonKey = SUPABASE_ANON_KEY;
