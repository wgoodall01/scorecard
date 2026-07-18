import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import type { Env } from "../env";
import { course, courseSet, hole, outing, outingPlayer, score, TEES, uuidv7 } from "../schema";
import { requireAuth, zodBody, zodQuery } from "./shared";

const NaiveDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const SubmitPlayerScores = z.object({
  playerId: z.string().min(1),
  tee: z.enum(TEES).nullable(),
  scores: z.array(
    z.object({
      holeNumber: z.number().int().min(1).max(18),
      score: z.number().int().min(1).nullable(),
    }),
  ),
});
export type SubmitPlayerScoresSchema = z.infer<typeof SubmitPlayerScores>;

export const NewCourseSet = z.object({
  name: z.string().trim().min(1),
  disposition: z.enum(["front", "back"]).nullable(),
  holes: z
    .array(z.object({ number: z.number().int().min(1).max(18), par: z.number().int().min(1) }))
    .min(1),
});
export type NewCourseSetSchema = z.infer<typeof NewCourseSet>;

const SubmitNine = z
  .object({
    // Exactly one of courseSetId (an existing set) or newSet (create it).
    courseSetId: z.string().min(1).nullable(),
    newSet: NewCourseSet.nullable(),
    players: z.array(SubmitPlayerScores).min(1),
  })
  .refine((nine) => (nine.courseSetId === null) !== (nine.newSet === null));

export const SubmitOutingRequest = z
  .object({
    date: NaiveDate,
    // The captured card these scores were read from (null = manual entry).
    scorecardId: z.string().min(1).nullable(),
    // Merge target: when set, scores are added to this outing and the
    // course/date come from it. Otherwise a new outing is created on
    // courseId, or on a newly created newCourse.
    outingId: z.string().min(1).nullable(),
    courseId: z.string().min(1).nullable(),
    newCourse: z
      .object({ name: z.string().trim().min(1), location: z.string().trim().min(1).nullable() })
      .nullable(),
    nines: z.array(SubmitNine).min(1),
  })
  .refine(
    (request) =>
      request.outingId !== null || (request.courseId === null) !== (request.newCourse === null),
  );
export type SubmitOutingRequestSchema = z.infer<typeof SubmitOutingRequest>;

// Everything the outing page needs, assembled from one relational query.
async function loadOutingDetail(db: ReturnType<typeof getDb>, id: string) {
  const found = await db.query.outing.findFirst({
    where: eq(outing.id, id),
    with: {
      course: true,
      players: { with: { player: { columns: { id: true, name: true, email: true } } } },
      scores: {
        with: {
          hole: { with: { courseSet: { with: { holes: true } } } },
          scorecard: true,
        },
      },
    },
  });
  if (!found) return null;

  // Group scores into the sets that were actually played.
  const sets = new Map<
    string,
    {
      id: string;
      name: string;
      disposition: "front" | "back" | null;
      holes: { id: string; number: number; name: string | null; par: number }[];
      // scores[playerId][holeId] = strokes
      scores: Record<string, Record<string, number>>;
    }
  >();
  for (const cell of found.scores) {
    const set = cell.hole.courseSet;
    let entry = sets.get(set.id);
    if (!entry) {
      entry = {
        id: set.id,
        name: set.name,
        disposition: set.disposition ?? null,
        holes: [...set.holes]
          .sort((a, b) => a.number - b.number)
          .map(({ id, number, name, par }) => ({ id, number, name, par })),
        scores: {},
      };
      sets.set(set.id, entry);
    }
    (entry.scores[cell.playerId] ??= {})[cell.holeId] = cell.score;
  }

  // The distinct captured cards these scores came from, oldest first.
  const scorecards = new Map<string, { id: string; createdAt: string }>();
  for (const cell of found.scores) {
    if (cell.scorecard) {
      scorecards.set(cell.scorecard.id, {
        id: cell.scorecard.id,
        createdAt: cell.scorecard.createdAt,
      });
    }
  }

  return {
    id: found.id,
    date: found.date,
    course: { id: found.course.id, name: found.course.name, location: found.course.location },
    players: found.players.map((entry) => ({
      id: entry.player.id,
      name: entry.player.name,
      email: entry.player.email,
      tee: entry.tee ?? null,
    })),
    sets: [...sets.values()].sort((a, b) => (a.holes[0]?.number ?? 0) - (b.holes[0]?.number ?? 0)),
    scorecards: [...scorecards.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

export type OutingDetail = NonNullable<Awaited<ReturnType<typeof loadOutingDetail>>>;

// Summaries for the outings list: course, players, sets, per-player strokes.
async function loadOutingSummaries(db: ReturnType<typeof getDb>, where?: ReturnType<typeof eq>) {
  const outings = await db.query.outing.findMany({
    where,
    orderBy: [desc(outing.date), desc(outing.id)],
    with: {
      course: true,
      players: { with: { player: { columns: { id: true, name: true, email: true } } } },
      scores: { with: { hole: { with: { courseSet: { columns: { id: true, name: true } } } } } },
    },
  });

  return outings.map((entry) => {
    const sets = new Map<string, string>();
    const totals = new Map<string, number>();
    for (const cell of entry.scores) {
      sets.set(cell.hole.courseSet.id, cell.hole.courseSet.name);
      totals.set(cell.playerId, (totals.get(cell.playerId) ?? 0) + cell.score);
    }
    return {
      id: entry.id,
      date: entry.date,
      course: { id: entry.course.id, name: entry.course.name },
      sets: [...sets.entries()].map(([id, name]) => ({ id, name })),
      players: entry.players.map((player) => ({
        id: player.player.id,
        name: player.player.name,
        email: player.player.email,
        total: totals.get(player.playerId) ?? null,
      })),
    };
  });
}

export const outingRoutes = new Hono<Env>()
  .get("/courses", requireAuth, async (c) => {
    const db = getDb(c.env.DB);
    const courses = await db.query.course.findMany({
      orderBy: [asc(course.name)],
      with: { sets: { orderBy: [asc(courseSet.name)], with: { holes: true, ratings: true } } },
    });
    return c.json({ courses });
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
  // fresh outings). Everything moves to the target: where both outings have
  // the same player+hole score or the same player, the target's row wins,
  // and the emptied source outing is deleted.
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
        // Drop source cells the target already has...
        db.delete(score).where(
          and(
            eq(score.outingId, sourceId),
            sql`(${score.playerId}, ${score.holeId}) IN
                (SELECT player_id, hole_id FROM score WHERE outing_id = ${targetId})`,
          ),
        ),
        // ...move the rest, and likewise for the per-outing player tees...
        db.update(score).set({ outingId: targetId }).where(eq(score.outingId, sourceId)),
        db.delete(outingPlayer).where(
          and(
            eq(outingPlayer.outingId, sourceId),
            sql`${outingPlayer.playerId} IN
                (SELECT player_id FROM outing_player WHERE outing_id = ${targetId})`,
          ),
        ),
        db
          .update(outingPlayer)
          .set({ outingId: targetId })
          .where(eq(outingPlayer.outingId, sourceId)),
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

      if (request.outingId) {
        const existing = await db.query.outing.findFirst({
          where: eq(outing.id, request.outingId),
        });
        if (!existing) return c.json({ error: "Outing not found" }, 404);
        outingId = existing.id;
        courseId = existing.courseId;
      } else {
        if (request.newCourse) {
          courseId = uuidv7();
          batch.push(
            db.insert(course).values({
              id: courseId,
              name: request.newCourse.name,
              location: request.newCourse.location,
            }),
          );
        } else {
          const existingCourse = await db.query.course.findFirst({
            where: eq(course.id, request.courseId ?? ""),
          });
          if (!existingCourse) return c.json({ error: "Course not found" }, 404);
          courseId = existingCourse.id;
        }
        outingId = uuidv7();
        batch.push(db.insert(outing).values({ id: outingId, date: request.date, courseId }));
      }

      // Per nine: resolve (or create) the course set and its holes, keyed by
      // hole number, then stage every player's non-null scores.
      const playerTees = new Map<string, (typeof TEES)[number] | null>();
      for (const nine of request.nines) {
        let holeIdByNumber: Map<number, string>;
        if (nine.newSet) {
          const setId = uuidv7();
          batch.push(
            db.insert(courseSet).values({
              id: setId,
              courseId,
              name: nine.newSet.name,
              disposition: nine.newSet.disposition,
            }),
          );
          holeIdByNumber = new Map();
          for (const newHole of nine.newSet.holes) {
            const holeId = uuidv7();
            holeIdByNumber.set(newHole.number, holeId);
            batch.push(
              db.insert(hole).values({
                id: holeId,
                courseSetId: setId,
                number: newHole.number,
                par: newHole.par,
              }),
            );
          }
        } else {
          const existingSet = await db.query.courseSet.findFirst({
            where: eq(courseSet.id, nine.courseSetId ?? ""),
            with: { holes: true },
          });
          if (!existingSet || existingSet.courseId !== courseId) {
            return c.json({ error: "Course set not found on this course" }, 404);
          }
          holeIdByNumber = new Map(existingSet.holes.map((entry) => [entry.number, entry.id]));
        }

        for (const player of nine.players) {
          if (!playerTees.has(player.playerId)) playerTees.set(player.playerId, player.tee);
          for (const cell of player.scores) {
            if (cell.score === null) continue;
            const holeId = holeIdByNumber.get(cell.holeNumber);
            if (!holeId) {
              return c.json(
                { error: `Hole ${cell.holeNumber} does not exist on the selected course set` },
                400,
              );
            }
            batch.push(
              db
                .insert(score)
                .values({
                  outingId,
                  playerId: player.playerId,
                  holeId,
                  score: cell.score,
                  scorecardId: request.scorecardId,
                })
                .onConflictDoUpdate({
                  target: [score.outingId, score.playerId, score.holeId],
                  set: { score: cell.score, scorecardId: request.scorecardId },
                }),
            );
          }
        }
      }

      for (const [playerId, tee] of playerTees) {
        batch.push(
          db
            .insert(outingPlayer)
            .values({ outingId, playerId, tee })
            .onConflictDoUpdate({
              target: [outingPlayer.outingId, outingPlayer.playerId],
              set: { tee },
            }),
        );
      }

      if (batch.length > 0) {
        await db.batch(batch as [(typeof batch)[number], ...typeof batch]);
      }

      return c.json({ outingId }, 201);
    },
  );
