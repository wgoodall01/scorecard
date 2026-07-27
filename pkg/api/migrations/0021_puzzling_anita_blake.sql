CREATE TABLE `gcapi_course` (
	`course_id` integer PRIMARY KEY NOT NULL,
	`club_name` varchar NOT NULL,
	`course_name` varchar,
	`city` varchar,
	`state` varchar,
	`country` varchar,
	`payload` json NOT NULL,
	`fetched_at` varchar NOT NULL,
	`created_at` varchar NOT NULL,
	`updated_at` varchar NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gcapi_course_club_name_idx` ON `gcapi_course` (`club_name`);--> statement-breakpoint
CREATE INDEX `gcapi_course_course_name_idx` ON `gcapi_course` (`course_name`);