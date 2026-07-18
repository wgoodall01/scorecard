CREATE TABLE `usga_course` (
	`course_id` integer PRIMARY KEY NOT NULL,
	`facility_id` integer NOT NULL,
	`name` varchar NOT NULL,
	`full_name` varchar NOT NULL,
	`address1` varchar,
	`address2` varchar,
	`city` varchar,
	`legacy_crp_course_id` integer,
	`created_at` varchar NOT NULL,
	`updated_at` varchar NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usga_course_facility_id_idx` ON `usga_course` (`facility_id`);--> statement-breakpoint
CREATE TABLE `usga_facility` (
	`facility_id` integer PRIMARY KEY NOT NULL,
	`name` varchar NOT NULL,
	`state` varchar,
	`country` varchar,
	`ent_country_code` integer,
	`ent_state_code` integer,
	`telephone` varchar,
	`email` varchar,
	`state_display` varchar,
	`created_at` varchar NOT NULL,
	`updated_at` varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usga_tee` (
	`tee_id` integer PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`name` varchar NOT NULL,
	`gender` varchar NOT NULL,
	`par` integer,
	`course_rating` real,
	`bogey_rating` real,
	`slope_rating` integer,
	`length` integer,
	`front9_course_rating` real,
	`front9_slope_rating` integer,
	`back9_course_rating` real,
	`back9_slope_rating` integer,
	`created_at` varchar NOT NULL,
	`updated_at` varchar NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usga_tee_course_id_idx` ON `usga_tee` (`course_id`);--> statement-breakpoint
ALTER TABLE `course_set_tee` ADD `usga_tee_id` integer;--> statement-breakpoint
CREATE INDEX `course_set_tee_usga_tee_id_idx` ON `course_set_tee` (`usga_tee_id`);