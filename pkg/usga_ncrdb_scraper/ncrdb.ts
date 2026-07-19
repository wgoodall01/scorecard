/**
 * Scraper for the USGA National Course Rating Database (NCRDB).
 *
 * https://ncrdb.usga.org
 *
 * The site sits behind Akamai bot protection and uses an ASP.NET Core
 * antiforgery token, so every search must be primed by first loading the
 * NCRListing page: that response sets the antiforgery cookie and embeds the
 * matching `__RequestVerificationToken` hidden input. We reuse both for the
 * `LoadCourses` POST. Course tee details come back as an HTML page which we
 * parse by hand (no DOM library in the Bun stdlib).
 *
 * Public API:
 *   searchCourses({ clubName, clubCity, clubState, clubCountry }) => CourseInfo[]
 *   describeCourse(courseId) => TeeInfo[]
 *
 * Uses only the Bun / Web standard library (fetch, URLSearchParams, regex).
 */

import {
  mkdirSync,
  existsSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";

const BASE = "https://ncrdb.usga.org";

// A real browser User-Agent is required; Akamai 403s obvious bots.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface CourseInfo {
  courseID: number;
  courseName: string;
  facilityID: number;
  facilityName: string;
  fullName: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  entCountryCode: number | null;
  entStateCode: number | null;
  legacyCRPCourseId: number | null;
  telephone: string | null;
  email: string | null;
  ratings: unknown[];
  stateDisplay: string | null;
}

export interface NineHoleRating {
  /** Course Rating for the nine, e.g. 35.7 */
  courseRating: number | null;
  /** Slope Rating for the nine, e.g. 127 */
  slopeRating: number | null;
}

export interface TeeInfo {
  teeId: number | null;
  teeName: string;
  /** "M" (men) or "F" (women) as reported by the USGA. */
  gender: "M" | "F" | string;
  par: number | null;
  courseRating: number | null;
  bogeyRating: number | null;
  slopeRating: number | null;
  /** Total measured length of the tee, in yards. */
  length: number | null;
  front9: NineHoleRating;
  back9: NineHoleRating;
}

export interface SearchArgs {
  /** Club name to search for (partial match, case-insensitive on the server). */
  clubName?: string;
  clubCity?: string;
  /** Two-letter state/province code, or "(Select)" for any. */
  clubState?: string;
  /** Country code, e.g. "USA". Defaults to "USA". */
  clubCountry?: string;
}

/**
 * A primed session: the antiforgery token plus the Cookie header string that
 * carries the matching antiforgery + Akamai cookies. Reusable across calls.
 */
export interface Session {
  token: string;
  cookie: string;
}

/** Merge Set-Cookie values into a `name=value; name=value` Cookie header. */
function collectCookies(res: Response, existing = ""): string {
  const jar = new Map<string, string>();
  for (const part of existing.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  // Bun exposes multiple Set-Cookie values via getSetCookie().
  const setCookies =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
  for (const sc of setCookies as string[]) {
    const first = sc.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Load the NCRListing page to obtain a fresh antiforgery token and the cookies
 * that validate it.
 */
async function fetchListing(): Promise<{ session: Session; html: string }> {
  const res = await fetch(`${BASE}/NCRListing`, {
    headers: {
      ...BROWSER_HEADERS,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to load NCRListing page: HTTP ${res.status}`);
  }
  const html = await res.text();
  const cookie = collectCookies(res);

  const match = html.match(/name="__RequestVerificationToken"[^>]*\bvalue="([^"]+)"/);
  if (!match) {
    throw new Error("Could not find __RequestVerificationToken on NCRListing page");
  }
  return { session: { token: match[1], cookie }, html };
}

export async function primeSession(): Promise<Session> {
  return (await fetchListing()).session;
}

/**
 * Parse the values of the `ddlStates` region filter as the site offers them.
 * The option values are ISO-3166-2-style codes, e.g. "US-AL" for Alabama — the
 * exact strings the LoadCourses handler expects in `clubState`.
 */
export function parseStates(html: string): { code: string; name: string }[] {
  const sel = html.match(/<select[^>]*id="ddlStates"[\s\S]*?<\/select>/i);
  if (!sel) return [];
  const out: { code: string; name: string }[] = [];
  for (const m of sel[0].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)) {
    if (m[1] === "(Select)" || m[1] === "") continue;
    out.push({ code: m[1], name: m[2].trim() });
  }
  return out;
}

/**
 * Search the NCRDB for courses. Returns the raw course listing (one entry per
 * rated course; a facility with multiple course layouts yields several rows).
 */
export async function searchCourses(
  args: SearchArgs = {},
  session?: Session,
): Promise<CourseInfo[]> {
  // Reuse a caller-supplied session (e.g. the bulk scraper) to avoid re-priming
  // — one antiforgery token is good for many searches within a session.
  session ??= await primeSession();

  const body = new URLSearchParams({
    clubName: args.clubName ?? "",
    clubCity: args.clubCity ?? "",
    clubState: args.clubState ?? "(Select)",
    clubCountry: args.clubCountry ?? "USA",
  });

  const res = await fetch(`${BASE}/NCRListing?handler=LoadCourses`, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      RequestVerificationToken: session.token,
      "X-Requested-With": "XMLHttpRequest",
      Origin: BASE,
      Referer: `${BASE}/NCRListing`,
      Cookie: session.cookie,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`LoadCourses failed: HTTP ${res.status}`);
  }
  return (await res.json()) as CourseInfo[];
}

// ---- Tee-info HTML parsing -------------------------------------------------

/** Strip tags and collapse whitespace from an HTML fragment. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNum(s: string): number | null {
  const t = s.trim();
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

/** Parse a "35.7 / 127" nine-hole cell into { courseRating, slopeRating }. */
function parseNine(cell: string): NineHoleRating {
  const [cr, slope] = textOf(cell).split("/");
  return {
    courseRating: cr !== undefined ? toNum(cr) : null,
    slopeRating: slope !== undefined ? toNum(slope) : null,
  };
}

/**
 * The `gvTee` table columns, in order. Hidden columns are still present as
 * <td> cells, so positional mapping is stable.
 *
 *  0 Tee Name        6 RatingF9      12 Slope(F9)
 *  1 Gender          7 RatingB9      13 Slope(B9)
 *  2 Par             8 Front(9)      14 TeeID
 *  3 Course Rating   9 Back(9)       15 Length
 *  4 Bogey Rating   10 Bogey(F9)     16 Calc CH button
 *  5 Slope Rating   11 Bogey(B9)     17 CH value
 */
function parseTeeTable(html: string): TeeInfo[] {
  const start = html.indexOf('id="gvTee"');
  if (start === -1) return [];
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end === -1 ? undefined : end);

  const tees: TeeInfo[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(table)) !== null) {
    const rowHtml = rowMatch[1];
    // Skip the header row (contains <th>).
    if (/<th[\s>]/i.test(rowHtml)) continue;

    const cells: string[] = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 16) continue; // not a data row

    tees.push({
      teeId: toNum(textOf(cells[14])),
      teeName: textOf(cells[0]),
      gender: textOf(cells[1]),
      par: toNum(textOf(cells[2])),
      courseRating: toNum(textOf(cells[3])),
      bogeyRating: toNum(textOf(cells[4])),
      slopeRating: toNum(textOf(cells[5])),
      length: toNum(textOf(cells[15])),
      front9: parseNine(cells[8]),
      back9: parseNine(cells[9]),
    });
  }
  return tees;
}

/**
 * Fetch the tee/rating details for a single course by its numeric courseID
 * (as returned in CourseInfo.courseID).
 */
export async function describeCourse(
  courseId: number | string,
  session?: Session,
): Promise<TeeInfo[]> {
  // The tee-info page needs the Akamai cookies too; prime a session for them.
  // The bulk scraper passes a shared session to avoid re-priming per course.
  session ??= await primeSession();

  const res = await fetch(
    `${BASE}/courseTeeInfo?CourseID=${encodeURIComponent(String(courseId))}`,
    {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `${BASE}/NCRListing`,
        Cookie: session.cookie,
      },
    },
  );
  if (!res.ok) {
    throw new Error(`courseTeeInfo failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  return parseTeeTable(html);
}

// ---- Bulk scrape -----------------------------------------------------------

type Phase = "courses" | "tees" | "done";

interface Checkpoint {
  updatedAt: string;
  rps: number;
  /** Which pass is in progress: state listings, then per-course tee details. */
  phase: Phase;
  totalStates: number;
  completedStates: string[];
  /** Number of lines committed to course.jsonl — used to trim partial writes. */
  courseLines: number;
  /** Pass 2: number of courses whose tees are fully committed (file-order index). */
  teeCoursesDone: number;
  /** Number of lines committed to tee.jsonl — used to trim partial writes. */
  teeLines: number;
}

/** Read the courseIDs out of course.jsonl in file order (pass 2 work list). */
function readCourseIDs(path: string): number[] {
  if (!existsSync(path)) return [];
  const ids: number[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    ids.push((JSON.parse(line) as CourseInfo).courseID);
  }
  return ids;
}

/**
 * A minimum-interval rate limiter. Returns a function to `await` before each
 * request; it resolves once enough time has passed to stay under `rps`.
 */
function rateLimiter(rps: number): () => Promise<void> {
  const minInterval = 1000 / rps;
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minInterval;
    if (wait > 0) await Bun.sleep(wait);
  };
}

/** Trim a JSONL file to its first `n` lines, dropping any partial trailing write. */
function truncateToLines(path: string, n: number): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  if (content === "") return;
  // Lines were written each terminated by "\n", so drop the empty trailing field.
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const kept = lines.slice(0, n);
  writeFileSync(path, kept.length ? kept.join("\n") + "\n" : "");
}

interface ScrapeOptions {
  rps: number;
  resume: boolean;
  outDir?: string;
  /**
   * Max concurrent in-flight requests in pass 2. Because each request has ~350ms
   * latency, sequential fetching tops out near 3 rps; a few workers in flight let
   * `rps` become a real target. Defaults to just enough to saturate `rps`.
   */
  concurrency?: number;
}

/**
 * Sweep the entire NCRDB in two passes, writing course.jsonl then tee.jsonl,
 * with a checkpoint.json rewritten after every request so the run is fully
 * resumable.
 *
 *   Pass 1 ("courses"): one LoadCourses request per state → course.jsonl, one
 *     full course record (facility fields inline) per line. Resumable per state.
 *   Pass 2 ("tees"): one courseTeeInfo request per course → tee.jsonl, one
 *     tee-rating record per line, each stamped with its courseID. Resumable per
 *     course (in course.jsonl file order).
 *
 * Both passes run in sequence in a single invocation; `--resume` picks up
 * wherever the last run stopped, including partway through pass 2.
 */
export async function scrape({
  rps,
  resume,
  outDir = "./output",
  concurrency,
}: ScrapeOptions): Promise<void> {
  // Enough workers to keep `rps` requests in flight given ~350ms latency, capped
  // at 8 (the endpoint plateaus near ~10 req/s regardless of more concurrency).
  // An explicit --concurrency is honored exactly; the auto-calc gets +2 spare
  // workers for good measure — they mostly sit rate-limited, which is fine. The
  // rps limiter still bounds the actual rate below this either way.
  const conc =
    concurrency !== undefined
      ? Math.max(1, Math.floor(concurrency))
      : Math.min(8, Math.ceil(rps / 1.5)) + 2;

  const coursePath = `${outDir}/course.jsonl`;
  const teePath = `${outDir}/tee.jsonl`;
  const checkpointPath = `${outDir}/checkpoint.json`;

  mkdirSync(outDir, { recursive: true });

  // The compressed *.jsonl.zst snapshots are written ONLY at the very end of a
  // successful scrape and are the committed static artifact. Their presence
  // therefore means "this scrape already finished": a fresh run refuses to
  // clobber them, and a --resume run refuses to continue past them.
  const outputFiles = existsSync(outDir) ? readdirSync(outDir) : [];
  const anyZst = outputFiles.some((f) => f.endsWith(".jsonl.zst"));
  const anyJsonl = outputFiles.some((f) => f.endsWith(".jsonl"));

  let phase: Phase = "courses";
  const completed = new Set<string>();
  let courseLines = 0;
  let teeCoursesDone = 0;
  let teeLines = 0;

  if (resume) {
    if (anyZst) {
      throw new Error(
        `${outDir}/ contains a compressed snapshot (*.jsonl.zst): this scrape is ` +
          `already complete. The .zst files are the final static snapshot, not ` +
          `resumable state — remove them to start over.`,
      );
    }
    if (existsSync(checkpointPath)) {
      const cp = JSON.parse(readFileSync(checkpointPath, "utf8")) as Checkpoint;
      phase = cp.phase ?? "courses";
      for (const s of cp.completedStates ?? []) completed.add(s);
      courseLines = cp.courseLines ?? 0;
      teeCoursesDone = cp.teeCoursesDone ?? 0;
      teeLines = cp.teeLines ?? 0;
      // A crash can leave rows appended for a unit that was never marked
      // complete; trim both files back to their last committed counts.
      truncateToLines(coursePath, courseLines);
      truncateToLines(teePath, teeLines);
      console.error(
        `Resuming at phase "${phase}": ${completed.size} states, ` +
          `${courseLines} courses, ${teeCoursesDone} courses' tees done.`,
      );
    } else {
      console.error("--resume given but no checkpoint found; starting fresh.");
    }
  } else if (anyJsonl || anyZst || existsSync(checkpointPath)) {
    throw new Error(
      `${outDir}/ already contains scrape data (*.jsonl, *.jsonl.zst, or ` +
        `checkpoint.json). Pass --resume to continue, or remove the files to ` +
        `start over.`,
    );
  }

  const limit = rateLimiter(rps);

  // One request to prime the session and, from the same page, learn the exact
  // region codes (e.g. "US-AL") the LoadCourses filter expects. The session is
  // reused across both passes (re-primed on error).
  await limit();
  const listing = await fetchListing();
  let session = listing.session;
  const states = parseStates(listing.html);
  if (states.length === 0) {
    throw new Error("No region options found on NCRListing page; cannot scrape.");
  }
  const totalStates = states.length;

  // Rewrites checkpoint.json from the current live counters. Called after every
  // committed request, so checkpoint always trails the durable file writes.
  const commit = () =>
    writeFileSync(
      checkpointPath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          rps,
          phase,
          totalStates,
          completedStates: [...completed],
          courseLines,
          teeCoursesDone,
          teeLines,
        } satisfies Checkpoint,
        null,
        2,
      ),
    );

  // ---- Pass 1: course listings, one request per state ----------------------
  if (phase === "courses") {
    for (const { code: state, name } of states) {
      if (completed.has(state)) continue;

      let courses: CourseInfo[];
      try {
        await limit();
        courses = await searchCourses({ clubState: state }, session);
      } catch (err) {
        // Token/cookies may have gone stale; re-prime once and retry.
        console.error(`  ${state}: retrying after error (${(err as Error).message})`);
        await limit();
        session = await primeSession();
        await limit();
        courses = await searchCourses({ clubState: state }, session);
      }

      let block = "";
      for (const c of courses) block += JSON.stringify(c) + "\n";

      // Append the state's data, then commit the checkpoint.
      if (block) appendFileSync(coursePath, block);
      courseLines += courses.length;
      completed.add(state);
      commit();

      console.error(
        `[${completed.size}/${totalStates}] ${state} (${name}): ` +
          `${courses.length} courses (total ${courseLines})`,
      );
    }

    phase = "tees";
    commit();
    console.error(`Pass 1 complete: ${courseLines} courses. Starting pass 2 (tees)…`);
  }

  // ---- Pass 2: tee details, one request per course -------------------------
  //
  // Concurrency with in-order commit: up to `conc` courseTeeInfo requests are in
  // flight at once (rate still bounded by `limit`), but results are appended to
  // tee.jsonl and checkpointed strictly in course.jsonl order. That keeps
  // teeCoursesDone a clean watermark, so resume/trim logic is unchanged.
  if (phase === "tees") {
    const courseIDs = readCourseIDs(coursePath);
    const N = courseIDs.length;

    const failuresPath = `${outDir}/tee_failures.jsonl`;
    const MAX_ATTEMPTS = 6;

    // One request per course, reusing the shared session's cookie jar. On error
    // (stale cookies, or a transient 5xx when the server is under our load) it
    // re-primes and retries with exponential backoff — a single flaky course
    // must never abort the whole crawl. Throws only after MAX_ATTEMPTS.
    const fetchTees = async (courseID: number): Promise<TeeInfo[]> => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await limit();
          return await describeCourse(courseID, session);
        } catch (err) {
          lastErr = err;
          if (attempt < MAX_ATTEMPTS) {
            const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
            console.error(
              `  course ${courseID}: attempt ${attempt}/${MAX_ATTEMPTS} failed ` +
                `(${(err as Error).message}); re-priming, retry in ${backoff}ms`,
            );
            try {
              session = await primeSession();
            } catch {
              /* keep the old session; the backoff may outlast the hiccup */
            }
            await Bun.sleep(backoff);
          }
        }
      }
      throw new Error(`${MAX_ATTEMPTS} attempts failed: ${(lastErr as Error)?.message ?? lastErr}`);
    };

    // Sliding window: `inflight[i]` is the pending fetch for course index i.
    const inflight = new Map<number, Promise<TeeInfo[]>>();
    let nextDispatch = teeCoursesDone;
    const fill = () => {
      while (nextDispatch < N && inflight.size < conc) {
        const i = nextDispatch;
        inflight.set(i, fetchTees(courseIDs[i]));
        nextDispatch++;
      }
    };

    console.error(
      `Pass 2: ${N - teeCoursesDone} courses left, ${conc} concurrent, ${rps} rps cap.`,
    );

    // For the live rate / ETA readout: measure against this run's starting point.
    const runStart = Date.now();
    const runStartDone = teeCoursesDone;
    fill();

    for (let i = teeCoursesDone; i < N; i++) {
      // Commit strictly in order: wait for course i even if later ones finished.
      // A course that fails every attempt is quarantined (logged to
      // tee_failures.jsonl) and committed with zero tees so the crawl proceeds;
      // the watermark still advances, so it won't be retried on resume.
      let tees: TeeInfo[];
      try {
        tees = await inflight.get(i)!;
      } catch (err) {
        console.error(`  [QUARANTINE] course ${courseIDs[i]}: ${(err as Error).message}`);
        appendFileSync(
          failuresPath,
          JSON.stringify({
            courseID: courseIDs[i],
            error: (err as Error).message,
            at: new Date().toISOString(),
          }) + "\n",
        );
        tees = [];
      }
      inflight.delete(i);

      // Stamp each tee with its courseID so tee.jsonl joins back to course.jsonl.
      let block = "";
      for (const t of tees) block += JSON.stringify({ courseID: courseIDs[i], ...t }) + "\n";

      if (block) appendFileSync(teePath, block);
      teeLines += tees.length;
      teeCoursesDone = i + 1;
      commit();

      if (teeCoursesDone % 25 === 0 || teeCoursesDone === N) {
        const elapsedSec = (Date.now() - runStart) / 1000;
        const doneThisRun = teeCoursesDone - runStartDone;
        const perMin = elapsedSec > 0 ? Math.round((doneThisRun / elapsedSec) * 60) : 0;
        const remaining = N - teeCoursesDone;
        const etaSec = doneThisRun > 0 ? (remaining * elapsedSec) / doneThisRun : 0;
        const etaAt = new Date(Date.now() + etaSec * 1000);
        const hh = String(etaAt.getHours()).padStart(2, "0");
        const mm = String(etaAt.getMinutes()).padStart(2, "0");
        console.error(
          `${teeCoursesDone}/${N}, ${perMin}/min, ETA ${hh}:${mm} in ${Math.round(etaSec / 60)}min`,
        );
      }

      fill(); // top the window back up to `conc`
    }

    phase = "done";
    commit();
  }

  // Write the committed static snapshot: compress every JSONL to a NEW
  // `<name>.zst` alongside it. The raw JSONL is left in place (only new files
  // are created); the .zst is the artifact checked into git. Reaching here means
  // the scrape completed — any earlier error throws before this. Runs on
  // resume-to-completion too (e.g. a crash between "done" and this step), since
  // it lives after both passes.
  for (const f of readdirSync(outDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const src = `${outDir}/${f}`;
    const raw = readFileSync(src);
    const packed = Bun.zstdCompressSync(raw, { level: 19 });
    writeFileSync(`${src}.zst`, packed);
    console.error(`  compressed ${f} → ${f}.zst (${raw.length} → ${packed.length} bytes)`);
  }

  console.error(
    `Done. ${courseLines} courses and ${teeLines} tees ` +
      `across ${completed.size} states → ${outDir}/`,
  );
}

// ---- CLI -------------------------------------------------------------------

if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (cmd === "search") {
    const courses = await searchCourses({ clubName: rest.join(" ") });
    console.log(JSON.stringify(courses, null, 2));
  } else if (cmd === "describe") {
    const tees = await describeCourse(rest[0]);
    console.log(JSON.stringify(tees, null, 2));
  } else if (cmd === "scrape") {
    let rps = 3;
    let resume = false;
    let concurrency: number | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--resume") resume = true;
      else if (a === "--rps") rps = Number(rest[++i]);
      else if (a.startsWith("--rps=")) rps = Number(a.slice("--rps=".length));
      else if (a === "--concurrency") concurrency = Number(rest[++i]);
      else if (a.startsWith("--concurrency="))
        concurrency = Number(a.slice("--concurrency=".length));
      else {
        console.error(`Unknown option: ${a}`);
        process.exit(1);
      }
    }
    if (!Number.isFinite(rps) || rps <= 0) {
      console.error("--rps must be a positive number");
      process.exit(1);
    }
    if (concurrency !== undefined && (!Number.isFinite(concurrency) || concurrency <= 0)) {
      console.error("--concurrency must be a positive number");
      process.exit(1);
    }
    await scrape({ rps, resume, concurrency });
  } else {
    console.error("Usage:");
    console.error("  bun ncrdb.ts search <club name>");
    console.error("  bun ncrdb.ts describe <courseId>");
    console.error("  bun ncrdb.ts scrape [--rps N] [--concurrency N] [--resume]");
    console.error("      Two passes into ./output/: course.jsonl (per state), then");
    console.error("      tee.jsonl (per course). checkpoint.json makes it resumable.");
    console.error("      Pass 2 runs up to --concurrency requests in flight (default");
    console.error("      derives from --rps), committing results in order.");
    process.exit(1);
  }
}
