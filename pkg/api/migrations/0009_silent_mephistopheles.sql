-- created_at/updated_at audit columns on every table (ISO-8601; maintained
-- by drizzle at the app level, backfilled to "now" here), plus the scorecard
-- restructure: rows are tagged with the uploading user and carry the scores
-- extraction result as an unindexed JSON column instead of R2 objects.
-- Hand-rewritten from drizzle-kit output: SQLite forbids ADD COLUMN NOT NULL
-- without a constant default, and the old scorecard rows (keyed by uploader
-- email, results in R2) can't gain a NOT NULL user_id — the table is
-- recreated empty, with score provenance pointers nulled first.
ALTER TABLE `course` ADD `created_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `course` ADD `updated_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `course_set` ADD `created_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `course_set` ADD `updated_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `course_set_tee` ADD `created_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `course_set_tee` ADD `updated_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `hole` ADD `created_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `hole` ADD `updated_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `nickname` ADD `created_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `nickname` ADD `updated_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `outing` ADD `created_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `outing` ADD `updated_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `score` ADD `created_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `score` ADD `updated_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `score_set` ADD `created_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `score_set` ADD `updated_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `user` ADD `created_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `user` ADD `updated_at` varchar NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `course` SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');--> statement-breakpoint
UPDATE `course_set` SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');--> statement-breakpoint
UPDATE `course_set_tee` SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');--> statement-breakpoint
UPDATE `hole` SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');--> statement-breakpoint
UPDATE `nickname` SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');--> statement-breakpoint
UPDATE `outing` SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');--> statement-breakpoint
UPDATE `score` SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');--> statement-breakpoint
UPDATE `score_set` SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');--> statement-breakpoint
UPDATE `user` SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');--> statement-breakpoint
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
UPDATE `score` SET scorecard_id = NULL;--> statement-breakpoint
DROP TABLE `scorecard`;--> statement-breakpoint
CREATE TABLE `scorecard` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scores_extract` json,
	`scores_error` varchar,
	`created_at` varchar NOT NULL DEFAULT '',
	`updated_at` varchar NOT NULL DEFAULT '',
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA defer_foreign_keys = false;
