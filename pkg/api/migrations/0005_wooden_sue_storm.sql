CREATE TABLE `scorecard` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` varchar NOT NULL,
	`uploader_email` varchar
);
--> statement-breakpoint
ALTER TABLE `score` ADD `scorecard_id` text REFERENCES scorecard(id);