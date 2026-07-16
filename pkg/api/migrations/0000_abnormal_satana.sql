DROP TABLE IF EXISTS `pings`;
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` varchar NOT NULL,
	`name` varchar
);
