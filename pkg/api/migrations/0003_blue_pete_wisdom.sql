CREATE TABLE `course` (
	`id` text PRIMARY KEY NOT NULL,
	`name` varchar NOT NULL,
	`location` varchar
);
--> statement-breakpoint
CREATE TABLE `course_set` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`name` varchar NOT NULL,
	`disposition` varchar,
	FOREIGN KEY (`course_id`) REFERENCES `course`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_set_name_unique` ON `course_set` (`course_id`,`name`);--> statement-breakpoint
CREATE TABLE `hole` (
	`id` text PRIMARY KEY NOT NULL,
	`course_set_id` text NOT NULL,
	`number` integer NOT NULL,
	`name` varchar,
	`par` integer NOT NULL,
	FOREIGN KEY (`course_set_id`) REFERENCES `course_set`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hole_number_unique` ON `hole` (`course_set_id`,`number`);--> statement-breakpoint
CREATE TABLE `nickname` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`nickname` varchar NOT NULL,
	`nickname_type` varchar NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `outing` (
	`id` text PRIMARY KEY NOT NULL,
	`date` varchar NOT NULL,
	`course_id` text NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `course`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `outing_player` (
	`id` text PRIMARY KEY NOT NULL,
	`outing_id` text NOT NULL,
	`player_id` text NOT NULL,
	`tee` varchar,
	FOREIGN KEY (`outing_id`) REFERENCES `outing`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outing_player_unique` ON `outing_player` (`outing_id`,`player_id`);--> statement-breakpoint
CREATE TABLE `score` (
	`id` text PRIMARY KEY NOT NULL,
	`outing_id` text NOT NULL,
	`player_id` text NOT NULL,
	`hole_id` text NOT NULL,
	`score` integer NOT NULL,
	FOREIGN KEY (`outing_id`) REFERENCES `outing`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hole_id`) REFERENCES `hole`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `score_cell_unique` ON `score` (`outing_id`,`player_id`,`hole_id`);--> statement-breakpoint
ALTER TABLE `user` ADD `handicap` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `preferred_tee` varchar;