/**
 * App configuration.
 *
 * Uses react-native-dotenv to load environment variables at build time:
 * - Debug builds: reads from `.env` (dev Supabase project)
 * - Release builds: Fastlane copies `.env.production` to `.env` before bundling (prod Supabase project)
 *
 * Same pattern as mobile (Expo loads .env/.env.production based on build type).
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@env";

export const supabaseUrl = SUPABASE_URL;
export const supabaseAnonKey = SUPABASE_ANON_KEY;
