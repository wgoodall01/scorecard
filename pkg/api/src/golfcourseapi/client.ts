import type { Env } from "../../env";
import { GolfCourseApiSearchResponse, type GolfCourseApiCourseSchema } from "./schema";

// A thin client over GolfCourseAPI's search endpoint — our LAYOUT source for
// the admin course-add flow (per-tee, per-hole par / yardage / stroke index).
// See ./schema.ts for what the live data does and doesn't carry.
//
// Only /v1/search is used: its response embeds each match's FULL tee and hole
// tree, so a club needs exactly ONE request — there's no reason to follow up
// with /v1/courses/{id}. (The write endpoints need a paid tier and we have no
// business pushing data upstream anyway.)

const SEARCH_URL = "https://api.golfcourseapi.com/v1/search";

// The free tier allows 50 requests/day, so a naive typeahead would exhaust the
// budget in one sitting. Every request is cached at the Cloudflare edge for a
// MONTH: course layouts effectively never change, and the admin flow re-searches
// the same club name repeatedly while a proposal is reviewed and retried (the
// research_course job deliberately re-runs the route's search rather than
// carrying the whole payload through the job spec, so it's a cache hit).
const CACHE_TTL_SECONDS = 2_592_000;

// Caching is done through fetch's `cf` options rather than the Cache API: it
// needs no read/write bookkeeping, the cache key is the URL (which carries no
// credentials — the key rides in a header), and `wrangler dev` simply ignores
// the option, so local development just talks to the upstream.
//
// `cf` isn't in the DOM's RequestInit, and the web's tsconfig type-checks the API
// sources it pulls in through the RPC AppType graph — including this module — so
// the init is typed locally and cast at the call site to compile under both.
type CacheableInit = RequestInit & {
  cf: { cacheTtl: number; cacheEverything: boolean };
};

export class GolfCourseApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GolfCourseApiError";
    this.status = status;
  }
}

function describeFailure(status: number): string {
  if (status === 401 || status === 403) return "GolfCourseAPI rejected our API key";
  if (status === 429) return "GolfCourseAPI rate limit reached (the free tier allows 50/day)";
  return `GolfCourseAPI returned ${status}`;
}

/**
 * Search GolfCourseAPI for a club or course name. Returns every match with its
 * full tee/hole tree — one 18-hole entry per rated nine-combination at a
 * multi-nine club, so a three-nine facility comes back as three courses
 * sharing a `club_name`.
 *
 * Cached at the edge for a month per query, keyed on the URL alone (the response
 * doesn't vary by caller). Throws GolfCourseApiError on a non-2xx.
 */
export async function searchGolfCourses(
  env: Env["Bindings"],
  query: string,
): Promise<GolfCourseApiCourseSchema[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const url = `${SEARCH_URL}?search_query=${encodeURIComponent(trimmed)}`;
  const response = await fetch(url, {
    headers: {
      // The spec's preferred scheme; the legacy `Key <token>` form still works.
      Authorization: `Bearer ${env.GOLFCOURSE_API_KEY}`,
      Accept: "application/json",
    },
    // cacheEverything, because a JSON API response isn't cached by default.
    cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
  } as CacheableInit);
  if (!response.ok) {
    throw new GolfCourseApiError(describeFailure(response.status), response.status);
  }

  const parsed = GolfCourseApiSearchResponse.safeParse(await response.json());
  if (!parsed.success) {
    throw new GolfCourseApiError(`GolfCourseAPI returned an unexpected shape: ${parsed.error}`);
  }
  return parsed.data.courses;
}
