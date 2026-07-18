PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` varchar,
	`name` varchar,
	`admin` integer DEFAULT false NOT NULL,
	`handicap` integer,
	`preferred_tee` varchar
);
--> statement-breakpoint
INSERT INTO `__new_user`("id", "email", "name", "admin", "handicap", "preferred_tee") SELECT "id", "email", "name", "admin", "handicap", "preferred_tee" FROM `user`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
ALTER TABLE `__new_user` RENAME TO `user`;--> statement-breakpoint
PRAGMA defer_foreign_keys = false;--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);