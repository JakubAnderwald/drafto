import Image from "next/image";
import { APP_STORE_URL, GOOGLE_PLAY_PUBLIC, GOOGLE_PLAY_URL } from "@/lib/store-links";

/*
 * Official store artwork, served unmodified from `public/badges/`. Apple's SVGs are cropped to
 * the badge edge and drawn at Apple's 40px onscreen minimum. Apple publishes a black badge and a
 * white one, shown in the light and dark theme respectively (`.theme-*-only` in globals.css).
 * Google publishes one badge, legible on both backdrops.
 */

interface AppleBadge {
  label: string;
  lightSrc: string;
  darkSrc: string;
  width: number;
}

const APPLE_BADGES: readonly AppleBadge[] = [
  {
    label: "Download Drafto on the App Store",
    lightSrc: "/badges/app-store-black.svg",
    darkSrc: "/badges/app-store-white.svg",
    width: 119.66,
  },
  {
    label: "Download Drafto on the Mac App Store",
    lightSrc: "/badges/mac-app-store-black.svg",
    darkSrc: "/badges/mac-app-store-white.svg",
    width: 156.1,
  },
];

const BADGE_HEIGHT = 40;

const badgeLinkClassName =
  "block rounded-md focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:outline-none";

export interface StoreBadgesProps {
  /** Whether to show the Google Play badge. Defaults to `GOOGLE_PLAY_PUBLIC`. */
  googlePlayPublic?: boolean;
}

export function StoreBadges({ googlePlayPublic = GOOGLE_PLAY_PUBLIC }: StoreBadgesProps) {
  return (
    <ul aria-label="Get the app" className="mt-8 flex flex-wrap items-center justify-center gap-3">
      {APPLE_BADGES.map((badge) => (
        <li key={badge.label}>
          <a href={APP_STORE_URL} aria-label={badge.label} className={badgeLinkClassName}>
            <Image
              src={badge.lightSrc}
              alt=""
              width={badge.width}
              height={BADGE_HEIGHT}
              unoptimized
              className="theme-light-only h-10 w-auto"
            />
            <Image
              src={badge.darkSrc}
              alt=""
              width={badge.width}
              height={BADGE_HEIGHT}
              unoptimized
              className="theme-dark-only h-10 w-auto"
            />
          </a>
        </li>
      ))}
      {googlePlayPublic && (
        <li>
          <a
            href={GOOGLE_PLAY_URL}
            aria-label="Get Drafto on Google Play"
            className={badgeLinkClassName}
          >
            {/*
             * Google's PNG (646×250) has transparent clear space built in: the badge itself is
             * 168px of the 250px height, 41px in from each edge. At 60px tall the badge is 40px,
             * like Apple's, and the -10px margin keeps the padding out of the row's layout.
             */}
            <Image
              src="/badges/google-play.png"
              alt=""
              width={155}
              height={60}
              unoptimized
              className="-m-2.5 block h-15 w-auto"
            />
          </a>
        </li>
      )}
    </ul>
  );
}
