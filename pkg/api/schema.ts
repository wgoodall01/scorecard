import { relations, sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const varchar = customType<{ data: string }>({
  dataType() {
    return "varchar";
  },
});

// An unindexed JSON blob (TEXT affinity), (de)serialized at the driver edge.
const json = customType<{ data: unknown; driverData: string }>({
  dataType() {
    return "json";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return JSON.parse(value);
  },
});

// Audit timestamps on every table: ISO-8601 strings maintained by drizzle
// ($defaultFn/$onUpdateFn — app-level, so raw-SQL writers like the seed
// script must set them explicitly; the migration backfills existing rows).
const isoNow = () => new Date().toISOString();
const timestamps = {
  createdAt: varchar("created_at").notNull().$defaultFn(isoNow),
  updatedAt: varchar("updated_at").notNull().$defaultFn(isoNow).$onUpdateFn(isoNow),
};

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

// App-level tee CATEGORIES. Real tees are course_set_tee rows with whatever
// name the course prints ("Blue", "White II", …); a row's nullable `type`
// tags it with one of these categories so a golfer's profile preference
// (user.preferred_tee) can pick a default tee on any course. Stored as plain
// varchar (null = uncategorized); this list is the app-level source of truth
// for validation and UI options.
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
    // The golfer's gender ("m"/"f"), or null. Drives which gendered tee
    // (course_set_tee.gender) a round defaults to — null falls back to the
    // men's tees. Not tied to account/login, just scorekeeping.
    gender: varchar("gender").$type<"m" | "f">(),
    preferredTee: varchar("preferred_tee").$type<Tee>(),
    ...timestamps,
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
    ...timestamps,
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
  // The captured scorecard this course was imported/updated from (admin
  // create-course flow), or null for seeded/hand-entered courses.
  importedScorecardId: text("imported_scorecard_id").references(() => scorecard.id),
  ...timestamps,
});

// A named set of holes (a "nine") within a course. There is no stored
// front/back disposition — a nine's place is derived from its holes'
// numbers where the UI needs it, which keeps sets nonoverlapping.
export const courseSet = sqliteTable(
  "course_set",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    courseId: text("course_id")
      .notNull()
      .references(() => course.id),
    name: varchar("name").notNull(),
    // USGA/NCRDB provenance: "this nine is the front/back half of THIS
    // rated 18-hole course" (the NCRDB rates nine-combinations,
    // ncrdb.usga.org/courseTeeInfo?CourseID=…). A nine's per-tee 9-hole
    // ratings are that course's Front(9)/Back(9) splits per usgaCourseNine.
    usgaCourseId: integer("usga_course_id"),
    usgaCourseNine: varchar("usga_course_nine").$type<"front" | "back">(),
    // Soft-delete: an ISO-8601 timestamp when this nine was archived (removed
    // during a course edit), else null. Archived nines are filtered out of every
    // NEW-score path (the /courses registry+capture list, course matching, outing
    // submission) but kept intact for HISTORICAL reads — old score_sets still
    // resolve their tee/holes by id, so past outings and handicaps stand.
    archivedAt: varchar("archived_at"),
    ...timestamps,
  },
  (table) => [uniqueIndex("course_set_name_unique").on(table.courseId, table.name)],
);

// A tee position on a nine — the thing a golfer actually plays from. `name`
// is whatever the course prints on the card/markers ("Blue", "White",
// "Combo I", …), `gender` the rated gender ("m"/"f", null = unspecified),
// and `type` the app-level TEES category used to match a golfer's profile
// preference (null = a tee outside the standard categories; those are still
// playable). courseRating is the 9-hole USGA rating in strokes to one
// decimal and slopeRating 55–155 (an 18-hole combination is rated by
// summing two nines' Course Ratings and averaging their Slopes); both are
// null when the tee is unrated — scores can still be recorded from it, they
// just can't post handicap differentials.
export const courseSetTee = sqliteTable(
  "course_set_tee",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    courseSetId: text("course_set_id")
      .notNull()
      .references(() => courseSet.id),
    name: varchar("name").notNull(),
    gender: varchar("gender").$type<"m" | "f">(),
    type: varchar("type").$type<Tee>(),
    courseRating: real("course_rating"),
    slopeRating: integer("slope_rating"),
    // Soft link to the USGA-imported tee (usga_tee.tee_id) this position was
    // copied from, when it originated from the NCRDB dump. Deliberately NOT a
    // foreign key: the usga_* tables are wholly owned by the scraper/sync
    // script and may be re-synced independently, so app writes must not depend
    // on a matching row existing. Indexed for lookups.
    usgaTeeId: integer("usga_tee_id"),
    ...timestamps,
  },
  (table) => [
    index("course_set_tee_usga_tee_id_idx").on(table.usgaTeeId),
    // One tee per (nine, name, gender), case-insensitively; gender NULL
    // coalesces so two ungendered "White" rows still collide. drizzle-kit
    // mangles multi-argument index expressions, so the generated SQL for
    // this index is maintained by hand in the migration.
    uniqueIndex("course_set_tee_unique").on(
      table.courseSetId,
      sql`lower(${table.name})`,
      sql`coalesce(${table.gender}, '')`,
    ),
  ],
);

// Holes belong to a TEE, not the nine itself — par (and one day yardage)
// legitimately differs between tee positions on the same nine.
export const hole = sqliteTable(
  "hole",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    courseSetTeeId: text("course_set_tee_id")
      .notNull()
      .references(() => courseSetTee.id),
    number: integer("number").notNull(),
    par: integer("par").notNull(),
    // Printed yardage from this tee, if known (null = not recorded). Like par,
    // yardage legitimately differs between tee positions on the same nine.
    yardage: integer("yardage"),
    ...timestamps,
  },
  (table) => [uniqueIndex("hole_number_unique").on(table.courseSetTeeId, table.number)],
);

// One or more scorecards recorded by a group of players in a single outing.
export const outing = sqliteTable("outing", {
  id: text("id").primaryKey().$defaultFn(uuidv7),
  // Naive calendar date, "YYYY-MM-DD" — no time or timezone.
  date: varchar("date").notNull(),
  courseId: text("course_id")
    .notNull()
    .references(() => course.id),
  ...timestamps,
});

// The root of a player's scores on one nine of an outing: which tee they
// played it from. A player gets one score_set per (outing, tee) — so a
// 27-hole day can mix tees nine-by-nine, and every score commits to a tee
// (it must: holes are per-tee rows).
export const scoreSet = sqliteTable(
  "score_set",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    outingId: text("outing_id")
      .notNull()
      .references(() => outing.id),
    playerId: text("player_id")
      .notNull()
      .references(() => user.id),
    courseSetTeeId: text("course_set_tee_id")
      .notNull()
      .references(() => courseSetTee.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("score_set_unique").on(table.outingId, table.playerId, table.courseSetTeeId),
  ],
);

// A background job — one row per submitted job, the source of truth for its
// whole lifecycle. The queue carries only the id; the consumer loads this
// row, dispatches on job_type, and updates state/result/error/status as it
// runs. Everything small (spec, progress reports, result, error) lives here
// so reads are cheap indexed D1, never R2; large artifacts a handler produces
// go to R2 under jobs/<id>/…. Each job type declares zod schemas for its spec
// and result (see src/jobs).
export const job = sqliteTable(
  "job",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    jobType: varchar("job_type").notNull(),
    // The full submitted spec ({ _job, id, ...args }), validated against the
    // job type's args schema at submit.
    spec: json("spec").notNull(),
    // Lifecycle state. The check constraint below ties it to result/error.
    state: varchar("state").$type<"running" | "ok" | "error">().notNull(),
    // The handler's return value on success (the job type's result schema);
    // null while running or on error.
    result: json("result"),
    // { message, stack, ... } when state='error'; null otherwise.
    error: json("error"),
    // The latest report({ message, ... }) the handler emitted — progress UX
    // only, not part of the state machine; null until the handler reports.
    status: json("status"),
    ...timestamps,
  },
  (table) => [
    index("job_type_idx").on(table.jobType),
    // Exactly one lifecycle shape is representable:
    //   running → result null,    error null
    //   ok      → result present, error null
    //   error   → result null,    error present
    check(
      "job_state_consistent",
      sql`(${table.state} = 'running' AND ${table.result} IS NULL AND ${table.error} IS NULL)
        OR (${table.state} = 'ok' AND ${table.result} IS NOT NULL AND ${table.error} IS NULL)
        OR (${table.state} = 'error' AND ${table.result} IS NULL AND ${table.error} IS NOT NULL)`,
    ),
    // The json customType serializes a top-level JS null to the TEXT 'null',
    // which is NOT SQL NULL and would sail past the IS NULL / IS NOT NULL
    // arms above. Forbid that literal outright so "absent" is always SQL NULL
    // and a present json value is never the null document.
    check(
      "job_json_not_null_literal",
      sql`${table.spec} <> 'null'
        AND (${table.result} IS NULL OR ${table.result} <> 'null')
        AND (${table.error} IS NULL OR ${table.error} <> 'null')
        AND (${table.status} IS NULL OR ${table.status} <> 'null')`,
    ),
  ],
);

// A captured scorecard image, created at upload and tagged with the
// uploading user. The id IS the capture id: the original photo lives in R2
// at cards/<id>/image. Extraction is a job — the row points at the
// extract_score job (if one was requested); its state/result carry the
// status and the { extracted, matched } data, so the scorecard row itself
// holds no extraction result.
export const scorecard = sqliteTable("scorecard", {
  id: text("id").primaryKey().$defaultFn(uuidv7),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  extractScoreJobId: text("extract_score_job_id").references(() => job.id),
  // Course-creation pipeline (admin flow): a card uploaded to create/update a
  // course points at its extract_metadata job (reads nine names + per-tee
  // pars/yardages) and the research_course job it feeds (reconciles that plus
  // the usga_* mirror into a CourseProposal). Both null for ordinary score
  // captures.
  extractMetadataJobId: text("extract_metadata_job_id").references(() => job.id),
  researchCourseJobId: text("research_course_job_id").references(() => job.id),
  ...timestamps,
});

export const score = sqliteTable(
  "score",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    scoreSetId: text("score_set_id")
      .notNull()
      .references(() => scoreSet.id),
    // Must belong to the score_set's tee (app-enforced; SQLite can't).
    holeId: text("hole_id")
      .notNull()
      .references(() => hole.id),
    score: integer("score").notNull(),
    // Which captured card this score was read from (null = entered by hand).
    scorecardId: text("scorecard_id").references(() => scorecard.id),
    ...timestamps,
  },
  (table) => [uniqueIndex("score_cell_unique").on(table.scoreSetId, table.holeId)],
);

// ---------------------------------------------------------------------------
// USGA NCRDB mirror (usga_*) — READ-ONLY to the application.
//
// These three tables are a flattened mirror of the USGA National Course Rating
// Database (ncrdb.usga.org), bulk-loaded by pkg/usga_ncrdb_scraper (the scraper
// writes JSONL, scripts/sync.nu upserts it here). They are WHOLLY OWNED by that
// scraper/sync pipeline: the app never INSERTs, UPDATEs, or DELETEs them — it
// only reads them (e.g. to look up a course's rated tees when importing it into
// the app-level course/course_set/course_set_tee tables, copying the values we
// need). The natural USGA integer ids are the primary keys, and every id
// (including cross-table references) is indexed. The USGA data has no per-hole
// pars/yardages, which is why the app keeps its own course/hole tables rather
// than pointing at these directly.
//
// The primitive columns are a direct flatten of the scraper's JSONL. Field
// placement is driven strictly by the data: a field lives on usga_facility only
// if it is IDENTICAL across every course a facility has; any field that ever
// differs between two courses of the same facility (street address, city,
// legacy id) lives on usga_course, so no varying value is ever lost by hoisting
// it to the facility.
// ---------------------------------------------------------------------------

// A USGA facility (a club/property). Keyed by the NCRDB facilityID. Holds only
// the fields verified constant across all of a facility's courses.
export const usgaFacility = sqliteTable("usga_facility", {
  facilityId: integer("facility_id").primaryKey(),
  name: varchar("name").notNull(),
  state: varchar("state"),
  country: varchar("country"),
  entCountryCode: integer("ent_country_code"),
  entStateCode: integer("ent_state_code"),
  telephone: varchar("telephone"),
  email: varchar("email"),
  stateDisplay: varchar("state_display"),
  ...timestamps,
});

// A USGA "course" — really one rated nine-hole COMBINATION at a facility (e.g.
// "WHITE/BLUE"), keyed by the NCRDB courseID. facility_id is the NCRDB
// facilityID (soft reference into usga_facility, indexed). Address/city live
// here (not on the facility) because they can differ course-to-course.
export const usgaCourse = sqliteTable(
  "usga_course",
  {
    courseId: integer("course_id").primaryKey(),
    facilityId: integer("facility_id").notNull(),
    name: varchar("name").notNull(),
    fullName: varchar("full_name").notNull(),
    address1: varchar("address1"),
    address2: varchar("address2"),
    city: varchar("city"),
    legacyCrpCourseId: integer("legacy_crp_course_id"),
    ...timestamps,
  },
  (table) => [index("usga_course_facility_id_idx").on(table.facilityId)],
);

// A USGA-rated tee position on a course (nine-combination), keyed by the NCRDB
// teeId (globally unique in the dump). course_id references usga_course
// (indexed). Nine-hole splits are flattened into front9_*/back9_* columns.
// Ratings are stored as reported: course/bogey ratings are strokes to one
// decimal (real), slope 55–155 (integer), length in yards (integer). Nulls
// carry through from the source (some tees have no length or no back-nine
// rating).
export const usgaTee = sqliteTable(
  "usga_tee",
  {
    teeId: integer("tee_id").primaryKey(),
    courseId: integer("course_id").notNull(),
    name: varchar("name").notNull(),
    // "M" or "F" as reported by the USGA.
    gender: varchar("gender").notNull(),
    par: integer("par"),
    courseRating: real("course_rating"),
    bogeyRating: real("bogey_rating"),
    slopeRating: integer("slope_rating"),
    length: integer("length"),
    front9CourseRating: real("front9_course_rating"),
    front9SlopeRating: integer("front9_slope_rating"),
    back9CourseRating: real("back9_course_rating"),
    back9SlopeRating: integer("back9_slope_rating"),
    ...timestamps,
  },
  (table) => [index("usga_tee_course_id_idx").on(table.courseId)],
);

export const userRelations = relations(user, ({ many }) => ({
  nicknames: many(nickname),
  scorecards: many(scorecard),
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
  tees: many(courseSetTee),
}));

export const courseSetTeeRelations = relations(courseSetTee, ({ one, many }) => ({
  courseSet: one(courseSet, {
    fields: [courseSetTee.courseSetId],
    references: [courseSet.id],
  }),
  holes: many(hole),
  scoreSets: many(scoreSet),
}));

export const holeRelations = relations(hole, ({ one, many }) => ({
  tee: one(courseSetTee, { fields: [hole.courseSetTeeId], references: [courseSetTee.id] }),
  scores: many(score),
}));

export const outingRelations = relations(outing, ({ one, many }) => ({
  course: one(course, { fields: [outing.courseId], references: [course.id] }),
  scoreSets: many(scoreSet),
}));

export const scoreSetRelations = relations(scoreSet, ({ one, many }) => ({
  outing: one(outing, { fields: [scoreSet.outingId], references: [outing.id] }),
  player: one(user, { fields: [scoreSet.playerId], references: [user.id] }),
  tee: one(courseSetTee, {
    fields: [scoreSet.courseSetTeeId],
    references: [courseSetTee.id],
  }),
  scores: many(score),
}));

export const scorecardRelations = relations(scorecard, ({ one, many }) => ({
  user: one(user, { fields: [scorecard.userId], references: [user.id] }),
  extractScoreJob: one(job, {
    fields: [scorecard.extractScoreJobId],
    references: [job.id],
    relationName: "extractScoreJob",
  }),
  extractMetadataJob: one(job, {
    fields: [scorecard.extractMetadataJobId],
    references: [job.id],
    relationName: "extractMetadataJob",
  }),
  researchCourseJob: one(job, {
    fields: [scorecard.researchCourseJobId],
    references: [job.id],
    relationName: "researchCourseJob",
  }),
  scores: many(score),
}));

export const scoreRelations = relations(score, ({ one }) => ({
  scoreSet: one(scoreSet, { fields: [score.scoreSetId], references: [scoreSet.id] }),
  hole: one(hole, { fields: [score.holeId], references: [hole.id] }),
  scorecard: one(scorecard, { fields: [score.scorecardId], references: [scorecard.id] }),
}));
