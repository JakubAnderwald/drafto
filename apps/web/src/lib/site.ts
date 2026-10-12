// The canonical public origin. Canonical links, robots.txt and the sitemap always point here,
// even when rendered on localhost or a Vercel preview, so search engines index only the apex
// host. `www.drafto.eu` redirects to it (308) in the Vercel domain settings, not in code.
export const SITE_URL = "https://drafto.eu";

// The public pages search engines should index, listed in the sitemap. Each one declares
// itself as its canonical URL. `/` is left out: it redirects signed-out visitors, crawlers
// included, to /login, and a sitemap lists only URLs that answer 200.
export const INDEXED_PATHS = ["/login", "/signup", "/privacy", "/support", "/account/delete"];
