import { relations, sql } from "drizzle-orm";
import { customType, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const varchar = customType<{ data: string }>({
  dataType() {
    return "varchar";
  },
});

export function uuidv7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const timestamp = BigInt(Date.now());

  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return [...bytes]
    .map((byte, index) => {
      const hex = byte.toString(16).padStart(2, "0");
      return [4, 6, 8, 10].includes(index) ? `-${hex}` : hex;
    })
    .join("");
}

// The tees a player can play from. Stored as plain varchar (null = unknown);
// this list is the app-level source of truth for validation and UI options.
export const TEES = ["tips", "back", "standard", "senior", "front", "junior"] as const;
export type Tee = (typeof TEES)[number];

export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    // Nullable: a golfer can exist purely as a player (seeded or added for
    // scorekeeping) without an account email; they can't sign in until one is
    // set. Uniqueness still holds for non-null values.
    email: varchar("email"),
    name: varchar("name"),
    admin: integer("admin", { mode: "boolean" }).notNull().default(false),
    handicap: integer("handicap"),
    preferredTee: varchar("preferred_tee").$type<Tee>(),
  },
  (table) => [uniqueIndex("user_email_unique").on(table.email)],
);

export const nickname = sqliteTable(
  "nickname",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    nickname: varchar("nickname").notNull(),
    nicknameType: varchar("nickname_type").notNull(),
  },
  (table) => [
    // A golfer can't hold the same nickname twice in different cases.
    uniqueIndex("nickname_user_nickname_unique").on(table.userId, sql`lower(${table.nickname})`),
  ],
);

export const course = sqliteTable("course", {
  id: text("id").primaryKey().$defaultFn(uuidv7),
  name: varchar("name").notNull(),
  location: varchar("location"),
  // The USGA course rating database's id for this facility (ncrdb.usga.org).
  ncrdbFacilityId: integer("ncrdb_facility_id"),
});

// A named set of holes (a "nine") within a course.
export const courseSet = sqliteTable(
  "course_set",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    courseId: text("course_id")
      .notNull()
      .references(() => course.id),
    name: varchar("name").notNull(),
    disposition: varchar("disposition").$type<"front" | "back">(),
    // The NCRDB "course" behind this nine's ratings — the database rates
    // 18-hole nine-combinations (ncrdb.usga.org/courseTeeInfo?CourseID=…), so
    // this is the combo this nine fronts, whose Front(9) split rates the nine.
    ncrdbCourseId: integer("ncrdb_course_id"),
  },
  (table) => [uniqueIndex("course_set_name_unique").on(table.courseId, table.name)],
);

// 9-hole USGA ratings for a nine, from a given app-level tee (the TEES
// enum; each course's seed maps those onto the tee markers the USGA rated —
// see seed/courses.yaml). courseRating is in strokes to one decimal,
// slopeRating 55–155. An 18-hole combination is rated by summing two nines'
// Course Ratings and averaging their Slopes. A (nine, tee) pair with no row
// is unrated from that tee.
export const courseSetRating = sqliteTable(
  "course_set_rating",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    courseSetId: text("course_set_id")
      .notNull()
      .references(() => courseSet.id),
    tee: varchar("tee").$type<Tee>().notNull(),
    courseRating: real("course_rating").notNull(),
    slopeRating: integer("slope_rating").notNull(),
  },
  (table) => [uniqueIndex("course_set_rating_unique").on(table.courseSetId, table.tee)],
);

export const hole = sqliteTable(
  "hole",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    courseSetId: text("course_set_id")
      .notNull()
      .references(() => courseSet.id),
    number: integer("number").notNull(),
    name: varchar("name"),
    par: integer("par").notNull(),
  },
  (table) => [uniqueIndex("hole_number_unique").on(table.courseSetId, table.number)],
);

// One or more scorecards recorded by a group of players in a single outing.
export const outing = sqliteTable("outing", {
  id: text("id").primaryKey().$defaultFn(uuidv7),
  // Naive calendar date, "YYYY-MM-DD" — no time or timezone.
  date: varchar("date").notNull(),
  courseId: text("course_id")
    .notNull()
    .references(() => course.id),
});

// Which tee each player played from on a given outing (null = not recorded).
export const outingPlayer = sqliteTable(
  "outing_player",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    outingId: text("outing_id")
      .notNull()
      .references(() => outing.id),
    playerId: text("player_id")
      .notNull()
      .references(() => user.id),
    tee: varchar("tee").$type<Tee>(),
  },
  (table) => [uniqueIndex("outing_player_unique").on(table.outingId, table.playerId)],
);

// A captured scorecard image. The id IS the capture id, so the original
// image, extracted.json, and matched.json live in R2 at cards/<id>/….
export const scorecard = sqliteTable("scorecard", {
  id: text("id").primaryKey(),
  // ISO timestamp of when the extraction completed.
  createdAt: varchar("created_at").notNull(),
  uploaderEmail: varchar("uploader_email"),
});

export const score = sqliteTable(
  "score",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    outingId: text("outing_id")
      .notNull()
      .references(() => outing.id),
    playerId: text("player_id")
      .notNull()
      .references(() => user.id),
    holeId: text("hole_id")
      .notNull()
      .references(() => hole.id),
    score: integer("score").notNull(),
    // Which captured card this score was read from (null = entered by hand).
    scorecardId: text("scorecard_id").references(() => scorecard.id),
  },
  (table) => [uniqueIndex("score_cell_unique").on(table.outingId, table.playerId, table.holeId)],
);

export const userRelations = relations(user, ({ many }) => ({
  nicknames: many(nickname),
}));

export const nicknameRelations = relations(nickname, ({ one }) => ({
  user: one(user, { fields: [nickname.userId], references: [user.id] }),
}));

export const courseRelations = relations(course, ({ many }) => ({
  sets: many(courseSet),
  outings: many(outing),
}));

export const courseSetRelations = relations(courseSet, ({ one, many }) => ({
  course: one(course, { fields: [courseSet.courseId], references: [course.id] }),
  holes: many(hole),
  ratings: many(courseSetRating),
}));

export const courseSetRatingRelations = relations(courseSetRating, ({ one }) => ({
  courseSet: one(courseSet, {
    fields: [courseSetRating.courseSetId],
    references: [courseSet.id],
  }),
}));

export const holeRelations = relations(hole, ({ one, many }) => ({
  courseSet: one(courseSet, { fields: [hole.courseSetId], references: [courseSet.id] }),
  scores: many(score),
}));

export const outingRelations = relations(outing, ({ one, many }) => ({
  course: one(course, { fields: [outing.courseId], references: [course.id] }),
  players: many(outingPlayer),
  scores: many(score),
}));

export const outingPlayerRelations = relations(outingPlayer, ({ one }) => ({
  outing: one(outing, { fields: [outingPlayer.outingId], references: [outing.id] }),
  player: one(user, { fields: [outingPlayer.playerId], references: [user.id] }),
}));

export const scorecardRelations = relations(scorecard, ({ many }) => ({
  scores: many(score),
}));

export const scoreRelations = relations(score, ({ one }) => ({
  outing: one(outing, { fields: [score.outingId], references: [outing.id] }),
  player: one(user, { fields: [score.playerId], references: [user.id] }),
  hole: one(hole, { fields: [score.holeId], references: [hole.id] }),
  scorecard: one(scorecard, { fields: [score.scorecardId], references: [scorecard.id] }),
}));
