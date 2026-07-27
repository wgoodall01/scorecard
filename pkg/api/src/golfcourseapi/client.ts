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
// budget in one sitting. Searches are cached in the Workers cache for a day —
// course layouts effectively never change, and the admin flow re-searches the
// same club name repeatedly while a proposal is reviewed and retried (the
// research_course job deliberately re-runs the route's search rather than
// carrying the whole payload through the job spec, so it's a cache hit).
//
// NOTE: `wrangler dev`'s cache is a no-op, so local development spends a real
// request per distinct query. Be sparing when testing against the free tier.
const CACHE_TTL_SECONDS = 86_400;

// `caches.default` is a Workers global that the web's tsconfig doesn't know
// about — and it type-checks the API sources it pulls in through the RPC
// AppType graph, which includes this module. Reach it through a narrow cast so
// the same file compiles under both configs.
function workerCache(): Cache | null {
  const store = caches as unknown as { default?: Cache };
  return store.default ?? null;
}

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
 * Cached for a day per query, keyed on the query alone (the response doesn't
 * vary by caller). Throws GolfCourseApiError on a non-2xx.
 */
export async function searchGolfCourses(
  env: Env["Bindings"],
  query: string,
): Promise<GolfCourseApiCourseSchema[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const url = `${SEARCH_URL}?search_query=${encodeURIComponent(trimmed)}`;
  // The cache is keyed by URL, so the key can be the upstream URL itself —
  // it carries no credentials.
  const cacheKey = new Request(url, { method: "GET" });
  const cache = workerCache();

  const cached = await cache?.match(cacheKey);
  if (cached) {
    return GolfCourseApiSearchResponse.parse(await cached.json()).courses;
  }

  const response = await fetch(url, {
    headers: {
      // The spec's preferred scheme; the legacy `Key <token>` form still works.
      Authorization: `Bearer ${env.GOLFCOURSE_API_KEY}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new GolfCourseApiError(describeFailure(response.status), response.status);
  }

  const body = await response.json();
  const parsed = GolfCourseApiSearchResponse.safeParse(body);
  if (!parsed.success) {
    throw new GolfCourseApiError(`GolfCourseAPI returned an unexpected shape: ${parsed.error}`);
  }

  // Cache the RAW body (not the parsed shape) so a later schema change reads
  // the original payload rather than a lossily-normalized one.
  await cache?.put(
    cacheKey,
    new Response(JSON.stringify(body), {
      headers: {
        "content-type": "application/json",
        "cache-control": `max-age=${CACHE_TTL_SECONDS}`,
      },
    }),
  );

  return parsed.data.courses;
}
