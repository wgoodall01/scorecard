// Honors: bragging rights (and dishonors) derived on demand from the scores
// in a date range of outings. No new tables, and no in-memory scoring:
// the entire board is ONE SQLite query (CTEs + window functions) that emits
// a single row with one json_object column per honor slug (NULL when
// unawarded — D1 caps compound-SELECT terms, so scalar-subquery columns
// instead of a UNION ALL arm per honor), and the app code is just a bind, a
// JSON.parse, and the Honor types below.

// A run of holes only counts as a streak honor from this length up.
export const MIN_STREAK = 3;

export type HonorHolder = { id: string; name: string | null; email: string | null };
export type HonorOutingRef = { id: string; date: string; courseName: string };

export type Honor =
  | {
      slug: "medalist";
      holder: HonorHolder;
      outing: HonorOutingRef;
      strokes: number;
      par: number;
      toPar: number;
      holes: number;
    }
  | {
      slug: "hot-nine";
      holder: HonorHolder;
      outing: HonorOutingRef;
      nineName: string;
      strokes: number;
      par: number;
      toPar: number;
    }
  | { slug: "birdie-machine"; holder: HonorHolder; birdies: number; latest: HonorOutingRef }
  | { slug: "par-machine"; holder: HonorHolder; pars: number; holes: number }
  | { slug: "metronome"; holder: HonorHolder; stdev: number; holes: number }
  | { slug: "iron-golfer"; holder: HonorHolder; outings: number; latest: HonorOutingRef }
  | {
      slug: "comeback-kid";
      holder: HonorHolder;
      outing: HonorOutingRef;
      frontToPar: number;
      backToPar: number;
      swing: number;
    }
  | {
      slug: "crater";
      holder: HonorHolder;
      outing: HonorOutingRef;
      holeNumber: number;
      nineName: string;
      par: number;
      strokes: number;
      overPar: number;
    }
  | {
      slug: "par-train";
      holder: HonorHolder;
      holes: number;
      startDate: string;
      latest: HonorOutingRef;
    }
  | {
      slug: "groundhog-day";
      holder: HonorHolder;
      holes: number;
      toPar: number;
      startDate: string;
      latest: HonorOutingRef;
    }
  | {
      slug: "broken-record";
      holder: HonorHolder;
      holes: number;
      score: number;
      startDate: string;
      latest: HonorOutingRef;
    }
  | {
      slug: "bogey-train";
      holder: HonorHolder;
      holes: number;
      startDate: string;
      latest: HonorOutingRef;
    }
  | {
      slug: "snowman";
      holder: HonorHolder;
      count: number;
      worst: number;
      latest: HonorOutingRef;
    }
  | { slug: "anchor"; holder: HonorHolder; avgOverPar: number; holes: number };

export type HonorSlug = Honor["slug"];

// Award rules, mirrored in the SQL below:
// - Every honor has a single holder; tie-breaks are (score, most recent
//   date, then player name) so standing titles must be defended.
// - Rate/consistency honors (par-machine, metronome, anchor) need >= 18
//   holes in the window; the anchor also needs >= 2 eligible players.
// - A "crater" is triple bogey or worse; a "snowman" is the classic 8+.
// - Streaks (par-train, bogey-train, groundhog-day, broken-record) run over
//   each player's holes in played order — date, then outing, then hole
//   number — so a streak carries across consecutive outings; they need
//   MIN_STREAK holes to count.
//
// Shape notes: `cells` is one row per recorded score with its hole, nine,
// outing, and player denormalized; `rounds` is per player-outing (with
// front/back-nine splits for the comeback); `nines` is per player-outing-set;
// `rated` is per player over the whole window (population stdev via
// sqrt(E[x^2] - E[x]^2), clamped for float error). ROW_NUMBER picks each
// player's most recent qualifying cell so "latest" outing refs come along
// for the ride. The `*_streaks` CTEs are gaps-and-islands: `seq` numbers a
// player's holes in played order, `grp` (seq minus a per-condition row
// number) is constant within a run, the `island` window aggregates the run,
// and pos = 1 keeps only its final cell — whose outing is the streak's
// "latest" ref.
const HONORS_SQL = /* sql */ `
WITH cells AS (
  SELECT
    o.id     AS outing_id,
    o.date   AS date,
    c.name   AS course_name,
    u.id     AS player_id,
    u.name   AS player_name,
    u.email  AS player_email,
    h.number AS hole_number,
    h.par    AS par,
    s.score  AS strokes,
    cs.id    AS set_id,
    cs.name  AS set_name
  FROM score s
  JOIN score_set ss     ON ss.id = s.score_set_id
  JOIN outing o         ON o.id = ss.outing_id
  JOIN course c         ON c.id = o.course_id
  JOIN "user" u         ON u.id = ss.player_id
  JOIN hole h           ON h.id = s.hole_id
  JOIN course_set_tee t ON t.id = h.course_set_tee_id
  JOIN course_set cs    ON cs.id = t.course_set_id
  WHERE o.date >= ?1 AND o.date <= ?2
),
rounds AS (
  SELECT
    outing_id, date, course_name, player_id, player_name, player_email,
    COUNT(*)           AS holes,
    SUM(strokes)       AS strokes,
    SUM(par)           AS par,
    SUM(strokes - par) AS to_par,
    SUM(hole_number <= 9)                                     AS front_holes,
    SUM(hole_number >= 10)                                    AS back_holes,
    SUM(CASE WHEN hole_number <= 9 THEN strokes - par ELSE 0 END)  AS front_to_par,
    SUM(CASE WHEN hole_number >= 10 THEN strokes - par ELSE 0 END) AS back_to_par
  FROM cells
  GROUP BY outing_id, player_id
),
nines AS (
  SELECT
    outing_id, date, course_name, player_id, player_name, player_email, set_name,
    COUNT(*)           AS holes,
    SUM(strokes)       AS strokes,
    SUM(par)           AS par,
    SUM(strokes - par) AS to_par
  FROM cells
  GROUP BY outing_id, player_id, set_id
),
rated AS (
  SELECT
    player_id, player_name, player_email,
    COUNT(*)            AS holes,
    SUM(strokes <= par) AS pars,
    AVG(strokes - par)  AS avg_over_par,
    sqrt(max(
      AVG((strokes - par) * (strokes - par)) - AVG(strokes - par) * AVG(strokes - par),
      0
    )) AS stdev
  FROM cells
  GROUP BY player_id
  HAVING COUNT(*) >= 18
),
birdies AS (
  SELECT
    player_id, player_name, player_email, outing_id, date, course_name,
    COUNT(*) OVER (PARTITION BY player_id) AS birdies,
    ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY date DESC, outing_id DESC) AS recency
  FROM cells
  WHERE strokes < par
),
attendance AS (
  SELECT
    player_id, player_name, player_email, outing_id, date, course_name,
    COUNT(*) OVER (PARTITION BY player_id) AS outings,
    ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY date DESC, outing_id DESC) AS recency
  FROM rounds
),
snowmen AS (
  SELECT
    player_id, player_name, player_email, outing_id, date, course_name,
    COUNT(*)      OVER (PARTITION BY player_id) AS snowman_count,
    MAX(strokes)  OVER (PARTITION BY player_id) AS worst,
    ROW_NUMBER()  OVER (PARTITION BY player_id ORDER BY date DESC, outing_id DESC) AS recency
  FROM cells
  WHERE strokes >= 8
),
seq_cells AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY player_id ORDER BY date, outing_id, hole_number, set_id
    ) AS seq
  FROM cells
),
par_streaks AS (
  SELECT
    player_id, player_name, player_email, outing_id, date, course_name,
    COUNT(*)     OVER island AS streak,
    MIN(date)    OVER island AS start_date,
    ROW_NUMBER() OVER (PARTITION BY player_id, grp ORDER BY seq DESC) AS pos
  FROM (
    SELECT *, seq - ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY seq) AS grp
    FROM seq_cells WHERE strokes <= par
  )
  WINDOW island AS (PARTITION BY player_id, grp)
),
bogey_streaks AS (
  SELECT
    player_id, player_name, player_email, outing_id, date, course_name,
    COUNT(*)     OVER island AS streak,
    MIN(date)    OVER island AS start_date,
    ROW_NUMBER() OVER (PARTITION BY player_id, grp ORDER BY seq DESC) AS pos
  FROM (
    SELECT *, seq - ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY seq) AS grp
    FROM seq_cells WHERE strokes >= par + 1
  )
  WINDOW island AS (PARTITION BY player_id, grp)
),
level_streaks AS (
  SELECT
    player_id, player_name, player_email, outing_id, date, course_name,
    strokes - par AS to_par,
    COUNT(*)     OVER island AS streak,
    MIN(date)    OVER island AS start_date,
    ROW_NUMBER() OVER (PARTITION BY player_id, strokes - par, grp ORDER BY seq DESC) AS pos
  FROM (
    SELECT *, seq - ROW_NUMBER() OVER (PARTITION BY player_id, strokes - par ORDER BY seq) AS grp
    FROM seq_cells
  )
  WINDOW island AS (PARTITION BY player_id, strokes - par, grp)
),
score_streaks AS (
  SELECT
    player_id, player_name, player_email, outing_id, date, course_name,
    strokes,
    COUNT(*)     OVER island AS streak,
    MIN(date)    OVER island AS start_date,
    ROW_NUMBER() OVER (PARTITION BY player_id, strokes, grp ORDER BY seq DESC) AS pos
  FROM (
    SELECT *, seq - ROW_NUMBER() OVER (PARTITION BY player_id, strokes ORDER BY seq) AS grp
    FROM seq_cells
  )
  WINDOW island AS (PARTITION BY player_id, strokes, grp)
)

SELECT
  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'outing', json_object('id', outing_id, 'date', date, 'courseName', course_name),
      'strokes', strokes, 'par', par, 'toPar', to_par, 'holes', holes
    )
    FROM (
      SELECT * FROM rounds WHERE holes >= 18
      ORDER BY to_par ASC, date DESC, COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "medalist",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'outing', json_object('id', outing_id, 'date', date, 'courseName', course_name),
      'nineName', set_name, 'strokes', strokes, 'par', par, 'toPar', to_par
    )
    FROM (
      SELECT * FROM nines WHERE holes = 9
      ORDER BY to_par ASC, date DESC, COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "hot-nine",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'birdies', birdies,
      'latest', json_object('id', outing_id, 'date', date, 'courseName', course_name)
    )
    FROM (
      SELECT * FROM birdies WHERE recency = 1
      ORDER BY birdies DESC, date DESC, COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "birdie-machine",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'pars', pars, 'holes', holes
    )
    FROM (
      SELECT * FROM rated WHERE pars > 0
      ORDER BY CAST(pars AS REAL) / holes DESC, holes DESC,
        COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "par-machine",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'stdev', stdev, 'holes', holes
    )
    FROM (
      SELECT * FROM rated
      ORDER BY stdev ASC, holes DESC, COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "metronome",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'outings', outings,
      'latest', json_object('id', outing_id, 'date', date, 'courseName', course_name)
    )
    FROM (
      SELECT * FROM attendance WHERE recency = 1
      ORDER BY outings DESC, date DESC, COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "iron-golfer",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'outing', json_object('id', outing_id, 'date', date, 'courseName', course_name),
      'frontToPar', front_to_par, 'backToPar', back_to_par,
      'swing', front_to_par - back_to_par
    )
    FROM (
      SELECT * FROM rounds
      WHERE front_holes = 9 AND back_holes = 9 AND front_to_par - back_to_par >= 1
      ORDER BY front_to_par - back_to_par DESC, date DESC,
        COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "comeback-kid",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'holes', streak, 'startDate', start_date,
      'latest', json_object('id', outing_id, 'date', date, 'courseName', course_name)
    )
    FROM (
      SELECT * FROM par_streaks WHERE pos = 1 AND streak >= ${MIN_STREAK}
      ORDER BY streak DESC, date DESC, COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "par-train",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'holes', streak, 'toPar', to_par, 'startDate', start_date,
      'latest', json_object('id', outing_id, 'date', date, 'courseName', course_name)
    )
    FROM (
      SELECT * FROM level_streaks WHERE pos = 1 AND streak >= ${MIN_STREAK}
      ORDER BY streak DESC, date DESC, COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "groundhog-day",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'holes', streak, 'score', strokes, 'startDate', start_date,
      'latest', json_object('id', outing_id, 'date', date, 'courseName', course_name)
    )
    FROM (
      SELECT * FROM score_streaks WHERE pos = 1 AND streak >= ${MIN_STREAK}
      ORDER BY streak DESC, date DESC, COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "broken-record",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'holes', streak, 'startDate', start_date,
      'latest', json_object('id', outing_id, 'date', date, 'courseName', course_name)
    )
    FROM (
      SELECT * FROM bogey_streaks WHERE pos = 1 AND streak >= ${MIN_STREAK}
      ORDER BY streak DESC, date DESC, COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "bogey-train",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'outing', json_object('id', outing_id, 'date', date, 'courseName', course_name),
      'holeNumber', hole_number, 'nineName', set_name, 'par', par,
      'strokes', strokes, 'overPar', strokes - par
    )
    FROM (
      SELECT * FROM cells WHERE strokes - par >= 3
      ORDER BY strokes - par DESC, strokes DESC, date DESC,
        COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "crater",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'count', snowman_count, 'worst', worst,
      'latest', json_object('id', outing_id, 'date', date, 'courseName', course_name)
    )
    FROM (
      SELECT * FROM snowmen WHERE recency = 1
      ORDER BY snowman_count DESC, worst DESC, date DESC,
        COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "snowman",

  (SELECT json_object(
      'holder', json_object('id', player_id, 'name', player_name, 'email', player_email),
      'avgOverPar', avg_over_par, 'holes', holes
    )
    FROM (
      SELECT * FROM rated
      WHERE (SELECT COUNT(*) FROM rated) >= 2
      ORDER BY avg_over_par DESC, COALESCE(player_name, player_email, '') ASC LIMIT 1
    )
  ) AS "anchor"
`;

// `since`/`until` are inclusive naive "YYYY-MM-DD" bounds on the outing date.
export async function computeHonors(
  db: D1Database,
  since: string,
  until: string,
): Promise<Honor[]> {
  const row = await db
    .prepare(HONORS_SQL)
    .bind(since, until)
    .first<Record<HonorSlug, string | null>>();
  if (!row) return [];
  return Object.entries(row).flatMap(([slug, data]) =>
    data === null ? [] : [{ slug, ...JSON.parse(data) } as Honor],
  );
}
