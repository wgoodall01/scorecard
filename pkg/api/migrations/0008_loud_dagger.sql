-- Tee restructure: real per-course tees (course_set_tee) replace the
-- hardcoded-tee ratings table, holes move under a tee, and score_set
-- (outing, player, tee) replaces outing_player as the root of scores.
-- Deliberately destructive to scoring/course-layout data: existing holes,
-- scores, tees, and ratings are dropped and re-seeded (hand-rewritten from
-- drizzle-kit output, which tried to copy columns that don't exist and
-- mangled the multi-argument unique index expression).
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
DROP TABLE `score`;--> statement-breakpoint
DROP TABLE `outing_player`;--> statement-breakpoint
DROP TABLE `course_set_rating`;--> statement-breakpoint
DROP TABLE `hole`;--> statement-breakpoint
DELETE FROM `outing`;--> statement-breakpoint
CREATE TABLE `course_set_tee` (
	`id` text PRIMARY KEY NOT NULL,
	`course_set_id` text NOT NULL,
	`name` varchar NOT NULL,
	`gender` varchar,
	`type` varchar,
	`course_rating` real,
	`slope_rating` integer,
	FOREIGN KEY (`course_set_id`) REFERENCES `course_set`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_set_tee_unique` ON `course_set_tee` (`course_set_id`,lower(`name`),coalesce(`gender`, ''));--> statement-breakpoint
CREATE TABLE `hole` (
	`id` text PRIMARY KEY NOT NULL,
	`course_set_tee_id` text NOT NULL,
	`number` integer NOT NULL,
	`par` integer NOT NULL,
	FOREIGN KEY (`course_set_tee_id`) REFERENCES `course_set_tee`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hole_number_unique` ON `hole` (`course_set_tee_id`,`number`);--> statement-breakpoint
CREATE TABLE `score_set` (
	`id` text PRIMARY KEY NOT NULL,
	`outing_id` text NOT NULL,
	`player_id` text NOT NULL,
	`course_set_tee_id` text NOT NULL,
	FOREIGN KEY (`outing_id`) REFERENCES `outing`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_set_tee_id`) REFERENCES `course_set_tee`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `score_set_unique` ON `score_set` (`outing_id`,`player_id`,`course_set_tee_id`);--> statement-breakpoint
CREATE TABLE `score` (
	`id` text PRIMARY KEY NOT NULL,
	`score_set_id` text NOT NULL,
	`hole_id` text NOT NULL,
	`score` integer NOT NULL,
	`scorecard_id` text,
	FOREIGN KEY (`score_set_id`) REFERENCES `score_set`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hole_id`) REFERENCES `hole`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scorecard_id`) REFERENCES `scorecard`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `score_cell_unique` ON `score` (`score_set_id`,`hole_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys = false;
