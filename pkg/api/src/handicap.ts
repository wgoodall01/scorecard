// The Handicap Index, computed per the World Handicap System (the USGA/R&A
// 2024 Rules of Handicapping, "RoH" below) over a player's full scoring
// record.
//
// ============================= HOW IT WORKS =============================
//
// A handicap answers one question: "how good is this golfer, really?" —
// as a number of strokes over par a scratch-relative player would expect
// them to shoot on a course of average difficulty. A 15.0 handicap means
// roughly "shoots about 15 over on a normal course on a decent day." Lower
// is better; a negative index (displayed "+2.1") means better than scratch.
//
// The catch is that raw scores aren't comparable. A 90 at a brutally hard
// course is a better round than an 88 at an easy one, and a great score on
// one day says more about your potential than your average day does. The
// WHS deals with both problems:
//
//   1. Every round is converted into a SCORE DIFFERENTIAL — "how well did
//      you play, adjusted for how hard the course was?" — so rounds from
//      different courses and tees land on one comparable scale.
//   2. Your handicap is an average of your BEST recent differentials (best
//      8 of the last 20 once you have a full record), not all of them. A
//      handicap measures demonstrated potential, not average performance —
//      which is why one hot round can move it a lot and a blow-up round
//      usually doesn't move it at all.
//
// --- Step 1: what makes a course "hard": Course Rating and Slope ---------
//
// Every set of tees on a rated course carries two USGA numbers:
//
//   COURSE RATING — the score a scratch golfer (a 0-handicap) is expected
//     to shoot. Buck Hill's White nine rates 35.0 for nine holes: par-ish
//     golf for an expert. Two nines add: White + Blue = 69.8 for the 18.
//
//   SLOPE RATING — how much harder the course gets for ordinary golfers
//     relative to experts, from 55 (flat, forgiving) to 155 (punishing).
//     113 is defined as "standard difficulty." A high-slope course
//     stretches out everyone's mistakes, so a bogey golfer's 92 there is
//     worth more credit than a 92 on a low-slope course. When two nines
//     combine into an 18, their slopes average: (125 + 126) / 2 = 125.5.
//
// --- Step 2: cap disaster holes (Adjusted Gross Score, RoH 3.1) ----------
//
// Before a round is graded, each hole's score is capped so one meltdown
// hole can't poison the whole record. The cap is NET DOUBLE BOGEY:
// par + 2, plus any handicap strokes the player "receives" on that hole
// (a 16-handicap gets one extra stroke on 16 of the 18 holes, so their cap
// is par + 3 there). Taking a 12 on a par 4 goes into the books as a 7.
// A brand-new player with no handicap yet gets a flat cap of par + 5.
// The capped total is the round's Adjusted Gross Score (AGS).
//
// (Real courses print a "stroke index" on the card ranking holes by
// difficulty to decide WHICH holes get the extra strokes. We don't capture
// that, so we rank holes by par, highest first — see strokesReceived.)
//
// --- Step 3: grade the round (the Score Differential, RoH 5.1) -----------
//
// The round's differential normalizes the adjusted score against the
// ratings of the tees actually played:
//
//   differential = (113 / Slope) x (AGS - Course Rating)
//
// Read it as: "strokes over what an expert would shoot here, rescaled to a
// standard-difficulty course." Example — a 92 (after capping) on Buck
// Hill's White + Blue nines:
//
//   (113 / 125.5) x (92 - 69.8) = 0.90 x 22.2 = 19.99 -> 20.0
//
// So that 92 counts as "20.0 over expert golf on a standard course." All
// differentials round to one decimal, halves upward.
//
// (The official formula also subtracts a "Playing Conditions Calculation"
// — a same-day, whole-field weather/setup adjustment only a golf
// association can compute. Ours is always 0.)
//
// --- Step 4: 9-hole rounds (RoH 5.1b) ------------------------------------
//
// The record is built from 18-hole scores, so a lone nine is topped up: the
// player's 9-hole differential (same formula, that nine's own ratings) is
// combined with the EXPECTED differential for the nine they didn't play,
// a function of their current handicap: expected = 0.52 x index + 1.2.
// Shoot your usual golf for nine holes and the system assumes an ordinary
// nine for the rest; a hot nine still lowers the total. (The USGA doesn't
// publish this formula — it's the one their GHIN system demonstrably uses,
// matching every official example to the decimal.)
//
// An outing maps to standard rounds first: complete rated nines pair up
// into 18-hole scores (ratings add, slopes average — that's how the USGA
// rates 27-hole facilities like Buck Hill, where any two nines form a
// rated 18), and one leftover nine posts as a 9-hole score. So a 27-hole
// day posts two differentials: an 18 and a 9.
//
// --- Step 5: from differentials to the Handicap Index (RoH 5.2) ----------
//
// With a full record, the index is the average of the LOWEST 8 of the most
// recent 20 differentials, rounded to a tenth. Bad rounds beyond your best
// 8 literally do not count — that's the "potential, not average" design.
//
// With fewer than 20 scores, a sliding table applies (see selectionFor):
// e.g. at 3 scores the index is your single lowest differential minus a
// -2.0 safety margin; at 6 it's the average of your lowest 2 minus 1.0.
// Small records are volatile BY DESIGN: with 3-5 scores, one career round
// simply IS your handicap. The smoothing only arrives as the record grows.
//
// --- Step 6: the safeguards --------------------------------------------
//
// Three mechanisms keep an index honest:
//
//   EXCEPTIONAL SCORE REDUCTION (RoH 5.9): post a round 7.0+ strokes
//     better than your current index and the whole recent record shifts
//     down 1.0 (2.0 if 10+ better) — "you just proved you're better than
//     your paper handicap says."
//
//   SOFT & HARD CAPS (RoH 5.8): once a LOW INDEX exists (your lowest index
//     of the trailing 365 days, tracked only after 20+ scores), upward
//     drift is braked: any rise beyond +3.0 over the low counts half, and
//     +5.0 over the low is a wall. Genuine improvement is never capped —
//     only movement in the flattering direction.
//
//   CEILING: no index exceeds 54.0.
//
// --- Why replay chronologically? ----------------------------------------
//
// Nearly every step depends on the handicap the player held WHEN THE ROUND
// WAS PLAYED: net-double-bogey caps use it, 9-hole expected scores use it,
// ESR compares against it, and the caps use the low-index history. So this
// module replays the record from the first round forward, updating the
// index after each posted score exactly as a handicap service would have
// on that day — and the per-round timeseries (charted on the golfer page)
// falls out of the same pass for free.
//
// --- Where we knowingly deviate from the book ----------------------------
//
// House rules, in the spirit of "show a provisional handicap wherever the
// math permits" rather than "not enough scores":
// - The WHS refuses to issue an index until 54 holes are posted (3
//   differentials). We extend the small-record table down to 1-2
//   differentials (lowest 1, -2.0, same as the 3-score row) and flag the
//   result `provisional` until the official 3 exist.
// - A 9-hole score posted before ANY index exists can't use the expected-
//   differential method (there's no index to expect from), so we bootstrap
//   by doubling the 9-hole differential — assume the missing nine went the
//   same way.
// - No stroke-index data (step 2 above): extra handicap strokes go to the
//   highest-par holes first. Plus-handicap give-back holes are ignored
//   (their cap is just par + 2) — it can shift a cap by at most a stroke
//   on one hole, for players who rarely hit the cap at all.
// - PCC is always 0 (it needs whole-field daily data only associations
//   have).
// - Exceptional Score Reductions apply only once the index is established
//   (>= 3 differentials); a "7 strokes better" upset of a one-round
//   provisional index is just the second data point.
//
// Data flow: one SQL query (bottom of file) pulls every scored hole with
// the 9-hole ratings of the tee the player actually played — no tee
// resolution is needed anymore: every score hangs off a score_set that
// names its course_set_tee, and that tee row carries the ratings (null =
// unrated, so the nine can't post a differential). computeHandicap groups
// rows into outings and complete nines; and handicapFromRounds (pure,
// unit-tested in handicap.test.ts against hand-worked examples) does
// everything described above.

// One USGA-standard "round" posted to the record: an outing yields one
// 18-hole score per pair of complete rated nines plus one 9-hole score for a
// leftover nine (so a 27-hole outing posts two rounds).
export type HandicapPoint = {
  outingId: string;
  date: string;
  // The nines this round was assembled from, and the gross strokes on them.
  setNames: string[];
  strokes: number;
  holes: 9 | 18;
  // This round's differential as first computed (later ESRs may lower the
  // stored copy used for averaging, but the point of record doesn't move).
  differential: number;
  // The Handicap Index after processing this round.
  index: number;
  provisional: boolean;
  // Whether this round's differential is among the ones the CURRENT index
  // averages (the lowest-n selection over the most recent 20).
  counted: boolean;
};

export type PlayerHandicap = {
  index: number | null;
  provisional: boolean;
  // Date of the most recent round in the record.
  asOf: string | null;
  differentialCount: number;
  timeseries: HandicapPoint[];
};

export const HANDICAP_MAX_INDEX = 54.0;
export const HANDICAP_ESTABLISHED_DIFFERENTIALS = 3;
const LOW_INDEX_WINDOW_DAYS = 365;
const LOW_INDEX_MIN_SCORES = 20;

// WHS rounding: nearest tenth with .5 rounded UP toward +infinity — the rule
// the official examples follow for negative values too (-1.55 -> -1.5).
function roundTenth(value: number) {
  return Math.floor(10 * value + 0.5) / 10;
}

function roundWhole(value: number) {
  return Math.floor(value + 0.5);
}

// RoH 5.2a: how many of the lowest differentials to average, and the safety
// adjustment subtracted, by record size — the official table verbatim (the
// 1-2 row is our provisional extension of the 3-score row):
//
//   scores in record | differentials used  | adjustment
//   -----------------+---------------------+-----------
//   1-2 (house rule) | lowest 1            | -2.0
//   3                | lowest 1            | -2.0
//   4                | lowest 1            | -1.0
//   5                | lowest 1            |  0
//   6                | average of lowest 2 | -1.0
//   7-8              | average of lowest 2 |  0
//   9-11             | average of lowest 3 |  0
//   12-14            | average of lowest 4 |  0
//   15-16            | average of lowest 5 |  0
//   17-18            | average of lowest 6 |  0
//   19               | average of lowest 7 |  0
//   20+              | lowest 8 of the     |  0
//                    |   most recent 20    |
//
// This is why small records star only one or two outings as "counting":
// until 6 scores exist, the handicap IS the single best round (minus the
// margin), and the familiar best-8-of-20 average only applies from 20 up.
function selectionFor(n: number): { use: number; adjustment: number } {
  if (n >= 20) return { use: 8, adjustment: 0 };
  if (n === 19) return { use: 7, adjustment: 0 };
  if (n >= 17) return { use: 6, adjustment: 0 };
  if (n >= 15) return { use: 5, adjustment: 0 };
  if (n >= 12) return { use: 4, adjustment: 0 };
  if (n >= 9) return { use: 3, adjustment: 0 };
  if (n >= 7) return { use: 2, adjustment: 0 };
  if (n === 6) return { use: 2, adjustment: -1.0 };
  if (n === 5) return { use: 1, adjustment: 0 };
  if (n === 4) return { use: 1, adjustment: -1.0 };
  return { use: 1, adjustment: -2.0 };
}

// RoH 5.1b: the expected score differential for the nine NOT played — what
// an average nine looks like for a player of this index (slightly worse
// than half their index, because differentials track potential, not
// average play). Depends on the index alone, never on where the nine was
// played. The USGA doesn't publish the formula; this is the one their GHIN
// system uses, reproducing every official example to the decimal.
function expectedNineDifferential(index: number) {
  return 0.52 * index + 1.2;
}

type RatedHole = { number: number; par: number; strokes: number };

type RatedNine = {
  // The course_set_tee the nine was played from — one player's nine on one
  // tee (the score_set grain), so its ratings are coherent per row group.
  teeId: string;
  name: string;
  par: number;
  courseRating: number;
  slopeRating: number;
  holes: RatedHole[];
};

type Round = { outingId: string; date: string; nines: RatedNine[] };

// How many handicap strokes the player "receives" on each hole, for the
// net-double-bogey cap. A COURSE HANDICAP of, say, 13 means 13 strokes
// spread over the round: every hole gets floor(13 / 18) = 0 baseline
// strokes and the 13 "hardest" holes get one extra (a 40-handicap on 18
// holes gets 2 everywhere and a third on the 4 hardest). Real scorecards
// rank hole difficulty with a printed stroke index; we don't have one, so
// holes rank by par descending, then hole number. The map is keyed by hole
// identity, not number — a Red/White-style combination pairs two front
// nines whose hole NUMBERS collide.
function strokesReceived(courseHandicap: number, holes: RatedHole[]): Map<RatedHole, number> {
  const received = new Map<RatedHole, number>();
  if (courseHandicap <= 0) {
    for (const hole of holes) received.set(hole, 0);
    return received;
  }
  const base = Math.floor(courseHandicap / holes.length);
  const extras = courseHandicap % holes.length;
  const byDifficulty = [...holes].sort((a, b) => b.par - a.par || a.number - b.number);
  byDifficulty.forEach((hole, rank) => {
    received.set(hole, base + (rank < extras ? 1 : 0));
  });
  return received;
}

// RoH 3.1: the Adjusted Gross Score — the round total with each hole capped
// so one disaster hole can't distort the record. With an index in effect
// the cap is net double bogey (par + 2 + strokes received on that hole);
// for a player with no index yet, a flat par + 5.
function adjustedGrossScore(holes: RatedHole[], courseHandicap: number | null) {
  const received = courseHandicap === null ? null : strokesReceived(courseHandicap, holes);
  return holes.reduce((sum, hole) => {
    const cap = received === null ? hole.par + 5 : hole.par + 2 + (received.get(hole) ?? 0);
    return sum + Math.min(hole.strokes, cap);
  }, 0);
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

type Differential = { value: number };

type IndexState = {
  index: number;
  provisional: boolean;
  // Low-index history: the index held after each score, with the record size
  // at the time (the Low Handicap Index only exists at >= 20 scores).
  held: { date: string; index: number; count: number }[];
  lowIndex: number | null;
};

// RoH 5.2 + 5.8: the index itself — average the lowest differentials from
// the most recent 20 per the selection table, subtract the small-record
// adjustment, then brake any upward drift against the Low Index: a rise
// beyond +3.0 over it counts half (soft cap), +5.0 over it is a wall (hard
// cap). Downward movement is never capped, and nothing exceeds 54.0.
function computeIndex(differentials: Differential[], lowIndex: number | null) {
  const recent = differentials.slice(-20).map((entry) => entry.value);
  const { use, adjustment } = selectionFor(recent.length);
  const lowest = [...recent].sort((a, b) => a - b).slice(0, use);
  let index = roundTenth(lowest.reduce((sum, value) => sum + value, 0) / use + adjustment);

  if (lowIndex !== null) {
    if (index - lowIndex > 3.0) index = roundTenth(lowIndex + 3.0 + 0.5 * (index - lowIndex - 3.0));
    index = Math.min(index, lowIndex + 5.0);
  }
  return Math.min(index, HANDICAP_MAX_INDEX);
}

// RoH 5.7: the Low Handicap Index — the lowest index the player held in the
// 365 days preceding the given score's date, including the index they
// carried INTO the window (an index set 400 days ago and never changed is
// still "held" today). It exists only once the record has 20 scores, and
// the value determined after one score takes effect for the NEXT score's
// caps — so it can be slightly stale, exactly as the rules specify.
function computeLowIndex(held: IndexState["held"], date: string): number | null {
  if (held.length === 0 || held[held.length - 1].count < LOW_INDEX_MIN_SCORES) return null;
  const windowStart = addDays(date, -LOW_INDEX_WINDOW_DAYS);
  let low: number | null = null;
  let carriedIn: number | null = null;
  for (const entry of held) {
    if (entry.count < LOW_INDEX_MIN_SCORES) continue;
    if (entry.date < windowStart) carriedIn = entry.index;
    else low = low === null ? entry.index : Math.min(low, entry.index);
  }
  if (carriedIn !== null) low = low === null ? carriedIn : Math.min(low, carriedIn);
  return low;
}

// The engine: replays the outings oldest-first, posting each standard round
// exactly as a handicap service would have on the day it was played (see
// "Why replay chronologically?" in the header), and emits one timeseries
// point per posted differential. Pure — exported for tests.
export function handicapFromRounds(rounds: Round[]): PlayerHandicap {
  const differentials: Differential[] = [];
  const timeseries: HandicapPoint[] = [];
  const state: IndexState = { index: 0, provisional: true, held: [], lowIndex: null };
  let established = false;
  let hasIndex = false;

  const post = (
    outingId: string,
    date: string,
    roundNines: RatedNine[],
    holes: 9 | 18,
    unrounded: number,
    lowIndexInEffect: number | null,
  ) => {
    const value = roundTenth(unrounded);
    differentials.push({ value });

    // RoH 5.9, the Exceptional Score Reduction: a round 7.0+ strokes better
    // than the index in effect (judged on the unrounded differential)
    // proves the player outclasses their paper handicap, so the stored
    // copies of the most recent 20 differentials — this one included — all
    // shift down 1.0 (2.0 when 10.0+ better). The shift is baked into the
    // stored values: it persists through later postings and fades only as
    // adjusted differentials age out of the recent-20 window.
    if (established) {
      const gap = state.index - unrounded;
      const reduction = gap >= 10.0 ? 2.0 : gap >= 7.0 ? 1.0 : 0;
      if (reduction > 0) {
        for (const entry of differentials.slice(-20)) entry.value -= reduction;
      }
    }

    state.index = computeIndex(differentials, lowIndexInEffect);
    hasIndex = true;
    established = differentials.length >= HANDICAP_ESTABLISHED_DIFFERENTIALS;
    state.provisional = !established;
    state.held.push({ date, index: state.index, count: differentials.length });

    timeseries.push({
      outingId,
      date,
      setNames: roundNines.map((nine) => nine.name),
      strokes: roundNines.reduce(
        (sum, nine) => sum + nine.holes.reduce((nineSum, hole) => nineSum + hole.strokes, 0),
        0,
      ),
      differential: value,
      holes,
      index: state.index,
      provisional: state.provisional,
      counted: false,
    });
  };

  for (const round of rounds) {
    // The index, Low Index, and course handicap in effect for this round are
    // the ones determined after the previous score (RoH 5.4, 5.7).
    const indexInEffect = hasIndex ? state.index : null;
    const lowIndexInEffect = state.lowIndex;

    // Convert the outing into USGA-standard rounds: complete rated nines
    // pair up in course order into 18-hole scores (Course Ratings add,
    // Slopes average — how the USGA itself rates a 27-hole facility's
    // combinations), and a leftover nine posts as a 9-hole score.
    // Incomplete or unrated nines can't produce differentials.
    const nines = [...round.nines].sort(
      (a, b) => (a.holes[0]?.number ?? 0) - (b.holes[0]?.number ?? 0),
    );
    for (let start = 0; start + 1 < nines.length; start += 2) {
      const [front, back] = [nines[start], nines[start + 1]];
      const courseRating = front.courseRating + back.courseRating;
      const slopeRating = (front.slopeRating + back.slopeRating) / 2;
      const par = front.par + back.par;
      const holes = [...front.holes, ...back.holes];
      const courseHandicap =
        indexInEffect === null
          ? null
          : roundWhole(indexInEffect * (slopeRating / 113) + (courseRating - par));
      const adjusted = adjustedGrossScore(holes, courseHandicap);
      post(
        round.outingId,
        round.date,
        [front, back],
        18,
        (113 / slopeRating) * (adjusted - courseRating),
        lowIndexInEffect,
      );
    }
    if (nines.length % 2 === 1) {
      const nine = nines[nines.length - 1];
      // RoH 6.1b: the 9-hole course handicap halves the index (rounded to a
      // tenth) before scaling by the nine's own ratings; the 9-hole
      // differential then gets topped up with the expected differential for
      // the nine not played — or, with no index yet to expect from, our
      // doubling bootstrap (see header).
      const courseHandicap =
        indexInEffect === null
          ? null
          : roundWhole(
              roundTenth(indexInEffect / 2) * (nine.slopeRating / 113) +
                (nine.courseRating - nine.par),
            );
      const adjusted = adjustedGrossScore(nine.holes, courseHandicap);
      const nineDifferential = (113 / nine.slopeRating) * (adjusted - nine.courseRating);
      const expected =
        indexInEffect === null ? nineDifferential : expectedNineDifferential(indexInEffect);
      post(round.outingId, round.date, [nine], 9, nineDifferential + expected, lowIndexInEffect);
    }

    if (timeseries.length > 0) {
      state.lowIndex = computeLowIndex(state.held, timeseries[timeseries.length - 1].date);
    }
  }

  // Mark the rounds the current index actually averages: the lowest `use`
  // of the most recent 20 differentials (ties resolve to the older round,
  // matching the stable sort in computeIndex). Points and differentials are
  // parallel arrays, so recent-window positions map straight back.
  const recent = differentials.slice(-20);
  const offset = differentials.length - recent.length;
  const { use } = selectionFor(recent.length);
  [...recent.keys()]
    .sort((a, b) => recent[a].value - recent[b].value)
    .slice(0, use)
    .forEach((position) => {
      timeseries[offset + position].counted = true;
    });

  const last = timeseries[timeseries.length - 1];
  return {
    index: last ? last.index : null,
    provisional: last ? last.provisional : true,
    asOf: last ? last.date : null,
    differentialCount: differentials.length,
    timeseries,
  };
}

// Every scored hole for the player with the ratings of the tee they played,
// oldest outing first. Raw D1 in the honors style — the service consumes
// flat rows. No tee resolution: the score's hole belongs to a
// course_set_tee, and that row IS the rating (null course/slope = unrated).
// Nines group by tee, not set — a player's nine on one tee is exactly the
// score_set grain, so each group's ratings are coherent.
const ROUNDS_SQL = /* sql */ `
SELECT
  o.id     AS outing_id,
  o.date   AS date,
  t.id     AS tee_id,
  cs.name  AS set_name,
  h.number AS hole_number,
  h.par    AS par,
  s.score  AS strokes,
  t.course_rating AS course_rating,
  t.slope_rating  AS slope_rating
FROM score s
JOIN score_set ss      ON ss.id = s.score_set_id
JOIN outing o          ON o.id = ss.outing_id
JOIN hole h            ON h.id = s.hole_id
JOIN course_set_tee t  ON t.id = h.course_set_tee_id
JOIN course_set cs     ON cs.id = t.course_set_id
WHERE ss.player_id = ?1
ORDER BY o.date ASC, o.id ASC, t.id ASC, h.number ASC
`;

type RoundRow = {
  outing_id: string;
  date: string;
  tee_id: string;
  set_name: string;
  hole_number: number;
  par: number;
  strokes: number;
  course_rating: number | null;
  slope_rating: number | null;
};

export async function computeHandicap(db: D1Database, playerId: string): Promise<PlayerHandicap> {
  const { results } = await db.prepare(ROUNDS_SQL).bind(playerId).all<RoundRow>();

  const rounds: Round[] = [];
  const roundsByOuting = new Map<string, Round>();
  const ninesByTee = new Map<string, RatedNine>();
  const unrated = new Set<string>();
  for (const row of results) {
    let round = roundsByOuting.get(row.outing_id);
    if (!round) {
      round = { outingId: row.outing_id, date: row.date, nines: [] };
      roundsByOuting.set(row.outing_id, round);
      rounds.push(round);
    }
    const nineKey = `${row.outing_id}/${row.tee_id}`;
    if (row.course_rating === null || row.slope_rating === null) unrated.add(nineKey);
    let nine = ninesByTee.get(nineKey);
    if (!nine) {
      nine = {
        teeId: row.tee_id,
        name: row.set_name,
        par: 0,
        courseRating: row.course_rating ?? 0,
        slopeRating: row.slope_rating ?? 0,
        holes: [],
      };
      ninesByTee.set(nineKey, nine);
      round.nines.push(nine);
    }
    nine.par += row.par;
    nine.holes.push({ number: row.hole_number, par: row.par, strokes: row.strokes });
  }

  // Only complete (all 9 holes scored), rated nines can post differentials.
  for (const round of rounds) {
    round.nines = round.nines.filter(
      (nine) => !unrated.has(`${round.outingId}/${nine.teeId}`) && nine.holes.length === 9,
    );
  }

  return handicapFromRounds(rounds);
}
