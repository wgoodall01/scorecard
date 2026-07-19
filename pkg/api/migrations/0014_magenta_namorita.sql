ALTER TABLE `course` ADD `imported_scorecard_id` text REFERENCES scorecard(id);--> statement-breakpoint
ALTER TABLE `course_set` ADD `archived_at` varchar;