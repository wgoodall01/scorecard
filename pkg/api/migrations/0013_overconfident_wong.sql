ALTER TABLE `hole` ADD `yardage` integer;--> statement-breakpoint
ALTER TABLE `scorecard` ADD `extract_metadata_job_id` text REFERENCES job(id);--> statement-breakpoint
ALTER TABLE `scorecard` ADD `research_course_job_id` text REFERENCES job(id);