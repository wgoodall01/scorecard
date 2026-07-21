import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { course, courseSet, courseSetTee, hole, outing, score, scoreSet, uuidv7 } from "../schema";
import { NaiveDate, requireAdmin, requireAuth, zodBody, zodQuery } from "./shared";

export const SubmitPlayerScores = z.object({
  playerId: z.string().min(1),
  // The tee this player played this nine from; must belong to the nine's
  // course set.
  courseSetTeeId: z.string().min(1),
  scores: z.array(
    z.object({
      holeNumber: z.number().int().min(1).max(18),
      score: z.number().int().min(1).nullable(),
    }),
  ),
});
export type SubmitPlayerScoresSchema = z.infer<typeof SubmitPlayerScores>;

// Submissions only ever reference EXISTING courses, sets, and tees — there
// is no API to create or edit course data; it's imported directly into the
// database (seed script, ratings scraper).
const SubmitNine = z.object({
  courseSetId: z.string().min(1),
  players: z.array(SubmitPlayerScores).min(1),
});

export const SubmitOutingRequest = z
  .object({
    date: NaiveDate,
    // The captured card these scores were read from (null = manual entry).
    scorecardId: z.string().min(1).nullable(),
    // Merge target: when set, scores are added to this outing and the
    // course/date come from it. Otherwise a new outing is created on
    // courseId.
    outingId: z.string().min(1).nullable(),
    courseId: z.string().min(1).nullable(),
    nines: z.array(SubmitNine).min(1),
  })
  .refine((request) => request.outingId !== null || request.courseId !== null);
export type SubmitOutingRequestSchema = z.infer<typeof SubmitOutingRequest>;

// Everything the outing page needs, assembled from one relational query.
// Scores key by hole NUMBER (not hole id): two players on the same nine may
// have played different tees, whose holes are distinct rows.
async function loadOutingDetail(db: ReturnType<typeof getDb>, id: string) {
  const found = await db.query.outing.findFirst({
    where: eq(outing.id, id),
    with: {
      course: true,
      scoreSets: {
        with: {
          player: { columns: { id: true, name: true, email: true } },
          tee: { with: { courseSet: true, holes: true } },
          scores: { with: { hole: true, scorecard: true } },
        },
      },
    },
  });
  if (!found) return null;

  // Group score sets into the course sets that were actually played.
  const sets = new Map<
    string,
    {
      id: string;
      name: string;
      // The display layout: the holes of the first tee seen on this set
      // (pars can differ slightly between tees; per-player exactness lives
      // in the score notation, which is judged server-side of the tee they
      // actually played via `parByPlayer`).
      holes: { number: number; par: number }[];
      // scores[playerId][holeNumber] = strokes
      scores: Record<string, Record<number, number>>;
      // Which tee each player played this nine from.
      tees: Record<string, { id: string; name: string }>;
      // parByPlayer[playerId][holeNumber] = par of the hole on THEIR tee.
      parByPlayer: Record<string, Record<number, number>>;
    }
  >();
  const players = new Map<string, { id: string; name: string | null; email: string | null }>();
  for (const played of found.scoreSets) {
    players.set(played.player.id, played.player);
    const set = played.tee.courseSet;
    let entry = sets.get(set.id);
    if (!entry) {
      entry = {
        id: set.id,
        name: set.name,
        holes: [...played.tee.holes]
          .sort((a, b) => a.number - b.number)
          .map(({ number, par }) => ({ number, par })),
        scores: {},
        tees: {},
        parByPlayer: {},
      };
      sets.set(set.id, entry);
    }
    entry.tees[played.playerId] = { id: played.tee.id, name: played.tee.name };
    const holePars = new Map(played.tee.holes.map((teeHole) => [teeHole.id, teeHole]));
    for (const cell of played.scores) {
      const teeHole = holePars.get(cell.holeId) ?? cell.hole;
      (entry.scores[played.playerId] ??= {})[teeHole.number] = cell.score;
      (entry.parByPlayer[played.playerId] ??= {})[teeHole.number] = teeHole.par;
    }
  }

  // The distinct captured cards these scores came from, oldest first.
  const scorecards = new Map<string, { id: string; createdAt: string }>();
  for (const played of found.scoreSets) {
    for (const cell of played.scores) {
      if (cell.scorecard) {
        scorecards.set(cell.scorecard.id, {
          id: cell.scorecard.id,
          createdAt: cell.scorecard.createdAt,
        });
      }
    }
  }

  return {
    id: found.id,
    date: found.date,
    course: { id: found.course.id, name: found.course.name, location: found.course.location },
    players: [...players.values()],
    sets: [...sets.values()].sort((a, b) => (a.holes[0]?.number ?? 0) - (b.holes[0]?.number ?? 0)),
    scorecards: [...scorecards.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

export type OutingDetail = NonNullable<Awaited<ReturnType<typeof loadOutingDetail>>>;

// Summaries for the outings list: course, players, sets, per-player strokes
// (flagged `incomplete` when the player scored some but not all of the
// outing's holes — an incomplete total isn't comparable to complete ones).
async function loadOutingSummaries(db: ReturnType<typeof getDb>, where?: ReturnType<typeof eq>) {
  const outings = await db.query.outing.findMany({
    where,
    orderBy: [desc(outing.date), desc(outing.id)],
    with: {
      course: true,
      scoreSets: {
        with: {
          player: { columns: { id: true, name: true, email: true } },
          tee: {
            with: {
              courseSet: { columns: { id: true, name: true } },
              holes: { columns: { number: true } },
            },
          },
          scores: { columns: { score: true } },
        },
      },
    },
  });

  return outings.map((entry) => {
    const sets = new Map<string, string>();
    const totals = new Map<string, number>();
    const scoredCells = new Map<string, number>();
    const players = new Map<string, { id: string; name: string | null; email: string | null }>();
    // The outing's hole count: per set, the union of hole numbers across
    // the tees that were actually played (they should agree).
    const holeNumbersBySet = new Map<string, Set<number>>();
    for (const played of entry.scoreSets) {
      sets.set(played.tee.courseSet.id, played.tee.courseSet.name);
      players.set(played.player.id, played.player);
      let numbers = holeNumbersBySet.get(played.tee.courseSet.id);
      if (!numbers) {
        numbers = new Set();
        holeNumbersBySet.set(played.tee.courseSet.id, numbers);
      }
      for (const teeHole of played.tee.holes) numbers.add(teeHole.number);
      for (const cell of played.scores) {
        totals.set(played.playerId, (totals.get(played.playerId) ?? 0) + cell.score);
        scoredCells.set(played.playerId, (scoredCells.get(played.playerId) ?? 0) + 1);
      }
    }
    const totalHoles = [...holeNumbersBySet.values()].reduce(
      (sum, numbers) => sum + numbers.size,
      0,
    );
    return {
      id: entry.id,
      date: entry.date,
      course: { id: entry.course.id, name: entry.course.name },
      sets: [...sets.entries()].map(([id, name]) => ({ id, name })),
      players: [...players.values()].map((player) => {
        const scored = scoredCells.get(player.id) ?? 0;
        return {
          id: player.id,
          name: player.name,
          email: player.email,
          total: totals.get(player.id) ?? null,
          incomplete: scored > 0 && scored < totalHoles,
        };
      }),
    };
  });
}

export const outingRoutes = new Hono<Env>()
  .get("/courses", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const courses = await db.query.course.findMany({
      // Archived courses (and archived nines) are hidden everywhere new scores
      // are recorded — the registry, the capture review picker — and here.
      where: isNull(course.archivedAt),
      orderBy: [asc(course.name)],
      with: {
        sets: {
          where: isNull(courseSet.archivedAt),
          orderBy: [asc(courseSet.name)],
          with: { tees: { orderBy: [asc(courseSetTee.name)], with: { holes: true } } },
        },
      },
    });
    return c.json({ courses });
  })
  // Every score ever recorded on ONE hole of a nine — where a "hole" is a
  // (course set, hole number) pair, spanning the per-tee `hole` rows that
  // share that number (par can differ by tee, so each score carries the par
  // of the tee it was played from). Drives the hole-statistics page; stats
  // (distribution, best/worst, consistency) are derived client-side from
  // this flat list, since it's one league's data.
  .get("/course-sets/:setId/holes/:number", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const setId = c.req.param("setId");
    const holeNumber = Number(c.req.param("number"));
    if (!Number.isInteger(holeNumber) || holeNumber < 1 || holeNumber > 18) {
      return c.json({ error: "Invalid hole number" }, 400);
    }

    const set = await db.query.courseSet.findFirst({
      where: eq(courseSet.id, setId),
      columns: { id: true, name: true },
      with: {
        course: { columns: { id: true, name: true } },
        tees: {
          columns: { id: true, name: true, gender: true, type: true },
          with: {
            holes: {
              where: eq(hole.number, holeNumber),
              columns: { id: true, par: true, yardage: true },
            },
          },
        },
      },
    });
    if (!set) return c.json({ error: "Course set not found" }, 404);

    // Map each per-tee `hole` row for this number to its tee and par.
    const holeMeta = new Map<string, { par: number; teeId: string; teeName: string }>();
    for (const tee of set.tees) {
      for (const teeHole of tee.holes) {
        holeMeta.set(teeHole.id, { par: teeHole.par, teeId: tee.id, teeName: tee.name });
      }
    }
    const holeIds = [...holeMeta.keys()];

    // Baseline par for display: the men's-standard tee where one exists (the
    // same choice the course registry's Par row makes), else any tee.
    const baselineTee =
      set.tees.find(
        (tee) => tee.type === "standard" && tee.gender === "m" && tee.holes.length > 0,
      ) ??
      set.tees.find((tee) => tee.type === "standard" && tee.holes.length > 0) ??
      set.tees.find((tee) => tee.holes.length > 0);
    const pars = [...new Set([...holeMeta.values()].map((meta) => meta.par))].sort((a, b) => a - b);
    const par = baselineTee?.holes[0]?.par ?? pars[0] ?? null;

    // Each tee's yardage/par on THIS hole, longest first (nulls last).
    const tees = set.tees
      .filter((tee) => tee.holes.length > 0)
      .map((tee) => ({
        id: tee.id,
        name: tee.name,
        gender: tee.gender,
        type: tee.type,
        par: tee.holes[0].par,
        yardage: tee.holes[0].yardage,
      }))
      .sort((a, b) => (b.yardage ?? -1) - (a.yardage ?? -1) || a.name.localeCompare(b.name));

    const scoreRows =
      holeIds.length === 0
        ? []
        : await db.query.score.findMany({
            where: inArray(score.holeId, holeIds),
            columns: { holeId: true, score: true },
            with: {
              scoreSet: {
                columns: {},
                with: {
                  outing: { columns: { id: true, date: true } },
                  player: { columns: { id: true, name: true, email: true } },
                },
              },
            },
          });

    const scores = scoreRows.map((row) => {
      const meta = holeMeta.get(row.holeId)!;
      return {
        playerId: row.scoreSet.player.id,
        playerName: row.scoreSet.player.name,
        playerEmail: row.scoreSet.player.email,
        outingId: row.scoreSet.outing.id,
        date: row.scoreSet.outing.date,
        teeId: meta.teeId,
        teeName: meta.teeName,
        par: meta.par,
        strokes: row.score,
      };
    });

    return c.json({
      hole: {
        number: holeNumber,
        courseId: set.course.id,
        courseName: set.course.name,
        setId: set.id,
        setName: set.name,
        pars,
        par,
      },
      tees,
      scores,
    });
  })
  .get(
    "/outings",
    requireAuth,
    zodQuery(
      z.object({
        courseId: z.string().optional(),
        courseSetId: z.string().optional(),
        playerId: z.string().optional(),
      }),
      "Invalid outing filters",
    ),
    async (c) => {
      const db = getDb(c.env.DB);
      const { courseId, courseSetId, playerId } = c.req.valid("query");
      let outings = await loadOutingSummaries(
        db,
        courseId ? eq(outing.courseId, courseId) : undefined,
      );

      // Set/player filters are applied over the summaries — the dataset is one
      // league's outings, so shipping the filter to SQL buys nothing yet.
      if (courseSetId) {
        outings = outings.filter((entry) => entry.sets.some((set) => set.id === courseSetId));
      }
      if (playerId) {
        outings = outings.filter((entry) => entry.players.some((player) => player.id === playerId));
      }

      return c.json({ outings });
    },
  )
  // Merge-candidate lookup: is there already an outing on this date with
  // scores on any of these course sets? Used by the capture review flow to
  // offer joining an existing outing (e.g. a foursome on two scorecards).
  .get(
    "/outings/check",
    requireAuth,
    zodQuery(
      z.object({ date: NaiveDate, courseSetIds: z.string().min(1) }),
      "A date and courseSetIds are required",
    ),
    async (c) => {
      const { date, courseSetIds: rawCourseSetIds } = c.req.valid("query");
      const courseSetIds = rawCourseSetIds.split(",").filter(Boolean);

      const db = getDb(c.env.DB);
      const candidates = await db.query.outing.findMany({ where: eq(outing.date, date) });
      for (const candidate of candidates) {
        const detail = await loadOutingDetail(db, candidate.id);
        if (detail?.sets.some((set) => courseSetIds.includes(set.id))) {
          return c.json({ outing: detail });
        }
      }
      return c.json({ outing: null });
    },
  )
  .get("/outings/:id", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const detail = await loadOutingDetail(db, c.req.param("id"));
    if (!detail) return c.json({ error: "Outing not found" }, 404);
    return c.json({ outing: detail });
  })
  // Merge another outing's rows into this one — the counterpart of the
  // capture flow's "add to existing outing", for two rounds that were
  // recorded separately (one foursome, two scorecards, both submitted as
  // fresh outings). Everything moves to the target. Where both outings have
  // a score for the same player on the same nine and hole number (whichever
  // tee it was recorded against), the target's cell wins; score sets that
  // duplicate a target (player, tee) pair pour their remaining scores into
  // the target's set, and the emptied source outing is deleted.
  .post(
    "/outings/:id/merge",
    requireAuth,
    zodBody(z.object({ outingId: z.string().min(1) }), "A source outing id is required"),
    async (c) => {
      const targetId = c.req.param("id");
      const { outingId: sourceId } = c.req.valid("json");
      if (sourceId === targetId) {
        return c.json({ error: "An outing can't be merged into itself" }, 400);
      }

      const db = getDb(c.env.DB);
      const [target, source] = await Promise.all([
        db.query.outing.findFirst({ where: eq(outing.id, targetId) }),
        db.query.outing.findFirst({ where: eq(outing.id, sourceId) }),
      ]);
      if (!target || !source) return c.json({ error: "Outing not found" }, 404);
      if (target.date !== source.date || target.courseId !== source.courseId) {
        return c.json({ error: "Only outings on the same date and course can be merged" }, 400);
      }

      await db.batch([
        // Drop source cells the target already has — same player, same
        // course set, same hole NUMBER (the tees, and so the hole ids, may
        // differ between the two recordings of the nine)...
        db.delete(score).where(
          sql`${score.scoreSetId} IN (SELECT id FROM score_set WHERE outing_id = ${sourceId})
              AND EXISTS (
                SELECT 1
                FROM score_set src
                JOIN course_set_tee src_tee ON src_tee.id = src.course_set_tee_id
                JOIN hole src_hole          ON src_hole.id = ${score.holeId}
                JOIN score_set tgt          ON tgt.outing_id = ${targetId}
                                           AND tgt.player_id = src.player_id
                JOIN course_set_tee tgt_tee ON tgt_tee.id = tgt.course_set_tee_id
                                           AND tgt_tee.course_set_id = src_tee.course_set_id
                JOIN hole tgt_hole          ON tgt_hole.course_set_tee_id = tgt_tee.id
                                           AND tgt_hole.number = src_hole.number
                JOIN score tgt_score        ON tgt_score.score_set_id = tgt.id
                                           AND tgt_score.hole_id = tgt_hole.id
                WHERE src.id = ${score.scoreSetId}
              )`,
        ),
        // ...pour scores whose (player, tee) score set already exists on the
        // target into that set...
        db
          .update(score)
          .set({
            scoreSetId: sql`(
              SELECT tgt.id FROM score_set src
              JOIN score_set tgt ON tgt.outing_id = ${targetId}
                                AND tgt.player_id = src.player_id
                                AND tgt.course_set_tee_id = src.course_set_tee_id
              WHERE src.id = ${score.scoreSetId})`,
          })
          .where(
            sql`${score.scoreSetId} IN (
              SELECT src.id FROM score_set src
              JOIN score_set tgt ON tgt.outing_id = ${targetId}
                                AND tgt.player_id = src.player_id
                                AND tgt.course_set_tee_id = src.course_set_tee_id
              WHERE src.outing_id = ${sourceId})`,
          ),
        // ...retire the source score sets those scores just left...
        db.delete(scoreSet).where(
          and(
            eq(scoreSet.outingId, sourceId),
            sql`EXISTS (
              SELECT 1 FROM score_set tgt
              WHERE tgt.outing_id = ${targetId}
                AND tgt.player_id = ${scoreSet.playerId}
                AND tgt.course_set_tee_id = ${scoreSet.courseSetTeeId})`,
          ),
        ),
        // ...move the remaining score sets wholesale...
        db.update(scoreSet).set({ outingId: targetId }).where(eq(scoreSet.outingId, sourceId)),
        // ...drop any score set the conflict pass emptied out...
        db
          .delete(scoreSet)
          .where(
            and(
              eq(scoreSet.outingId, targetId),
              sql`NOT EXISTS (SELECT 1 FROM score s WHERE s.score_set_id = ${scoreSet.id})`,
            ),
          ),
        // ...then retire the emptied source outing.
        db.delete(outing).where(eq(outing.id, sourceId)),
      ]);

      return c.json({ outingId: targetId });
    },
  )
  .post(
    "/outings",
    requireAuth,
    zodBody(SubmitOutingRequest, "A valid outing submission is required"),
    async (c) => {
      const request = c.req.valid("json");

      // Outings can't be post-dated. The date is naive and the client's
      // local calendar may run ahead of UTC, so "today" is judged in the
      // most-ahead timezone on Earth (UTC+14) — anything later is a date
      // that hasn't happened anywhere yet. Merges skip this: the submitted
      // date is ignored in favor of the existing outing's.
      const maxToday = new Date(Date.now() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (!request.outingId && request.date > maxToday) {
        return c.json({ error: "The outing date is in the future" }, 400);
      }

      const db = getDb(c.env.DB);

      // Resolve the target outing and course. All generated rows get their
      // ids up front so the whole write can go through one atomic batch.
      let outingId: string;
      let courseId: string;
      const batch: Parameters<typeof db.batch>[0][number][] = [];

      // Score sets that already exist on the target outing (merge case),
      // keyed player/tee — scores upsert into them rather than tripping the
      // score_set unique index.
      const scoreSetIds = new Map<string, string>();
      if (request.outingId) {
        const existing = await db.query.outing.findFirst({
          where: eq(outing.id, request.outingId),
          with: { scoreSets: true },
        });
        if (!existing) return c.json({ error: "Outing not found" }, 404);
        outingId = existing.id;
        courseId = existing.courseId;
        for (const existingSet of existing.scoreSets) {
          scoreSetIds.set(`${existingSet.playerId}/${existingSet.courseSetTeeId}`, existingSet.id);
        }
      } else {
        const existingCourse = await db.query.course.findFirst({
          where: eq(course.id, request.courseId ?? ""),
        });
        if (!existingCourse) return c.json({ error: "Course not found" }, 404);
        if (existingCourse.archivedAt) {
          return c.json({ error: "That course has been archived" }, 400);
        }
        courseId = existingCourse.id;
        outingId = uuidv7();
        batch.push(db.insert(outing).values({ id: outingId, date: request.date, courseId }));
      }

      // Per nine: resolve the course set with its tees and their holes, then
      // stage every player's score set and non-null scores.
      for (const nine of request.nines) {
        const existingSet = await db.query.courseSet.findFirst({
          where: eq(courseSet.id, nine.courseSetId),
          with: { tees: { with: { holes: true } } },
        });
        if (!existingSet || existingSet.courseId !== courseId) {
          return c.json({ error: "Course set not found on this course" }, 404);
        }
        if (existingSet.archivedAt) {
          return c.json({ error: "That nine has been archived" }, 400);
        }
        // holeIdByNumber per tee id.
        const holesByTee = new Map<string, Map<number, string>>(
          existingSet.tees.map((tee) => [
            tee.id,
            new Map(tee.holes.map((entry) => [entry.number, entry.id])),
          ]),
        );

        for (const player of nine.players) {
          const teeId = player.courseSetTeeId;
          if (!holesByTee.has(teeId)) {
            return c.json({ error: "Tee not found on the selected course set" }, 400);
          }
          const holeIdByNumber = holesByTee.get(teeId)!;

          const scoreSetKey = `${player.playerId}/${teeId}`;
          let scoreSetId = scoreSetIds.get(scoreSetKey);
          if (!scoreSetId) {
            scoreSetId = uuidv7();
            scoreSetIds.set(scoreSetKey, scoreSetId);
            batch.push(
              db.insert(scoreSet).values({
                id: scoreSetId,
                outingId,
                playerId: player.playerId,
                courseSetTeeId: teeId,
              }),
            );
          }

          for (const cell of player.scores) {
            if (cell.score === null) continue;
            const holeId = holeIdByNumber.get(cell.holeNumber);
            if (!holeId) {
              return c.json(
                { error: `Hole ${cell.holeNumber} does not exist on the selected tee` },
                400,
              );
            }
            batch.push(
              db
                .insert(score)
                .values({
                  scoreSetId,
                  holeId,
                  score: cell.score,
                  scorecardId: request.scorecardId,
                })
                .onConflictDoUpdate({
                  target: [score.scoreSetId, score.holeId],
                  set: { score: cell.score, scorecardId: request.scorecardId },
                }),
            );
          }
        }
      }

      if (batch.length > 0) {
        await db.batch(batch as [(typeof batch)[number], ...typeof batch]);
      }

      return c.json({ outingId }, 201);
    },
  )
  // Admin-only: delete an outing and every score recorded in it. Children go
  // before parents so foreign keys hold (scores → score_sets → outing). The
  // captured scorecards themselves are left alone.
  .delete("/outings/:id", requireAuth, requireAdmin, async (c) => {
    const db = getDb(c.env.DB);
    const id = c.req.param("id");
    const existing = await db.query.outing.findFirst({
      where: eq(outing.id, id),
      with: { scoreSets: { columns: { id: true } } },
    });
    if (!existing) return c.json({ error: "Outing not found" }, 404);

    const setIds = existing.scoreSets.map((set) => set.id);
    const batch: Parameters<typeof db.batch>[0][number][] = [];
    if (setIds.length > 0) batch.push(db.delete(score).where(inArray(score.scoreSetId, setIds)));
    batch.push(db.delete(scoreSet).where(eq(scoreSet.outingId, id)));
    batch.push(db.delete(outing).where(eq(outing.id, id)));
    await db.batch(batch as [(typeof batch)[number], ...typeof batch]);

    return c.json({ ok: true });
  });
