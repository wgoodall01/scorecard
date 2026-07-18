CREATE TABLE `course_set_rating` (
	`id` text PRIMARY KEY NOT NULL,
	`course_set_id` text NOT NULL,
	`tee` varchar NOT NULL,
	`course_rating` real NOT NULL,
	`slope_rating` integer NOT NULL,
	FOREIGN KEY (`course_set_id`) REFERENCES `course_set`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_set_rating_unique` ON `course_set_rating` (`course_set_id`,`tee`);--> statement-breakpoint
ALTER TABLE `course` ADD `ncrdb_facility_id` integer;--> statement-breakpoint
ALTER TABLE `course_set` ADD `ncrdb_course_id` integer;