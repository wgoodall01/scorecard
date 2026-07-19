CREATE TABLE `credential` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` varchar NOT NULL,
	`public_key` varchar NOT NULL,
	`counter` integer NOT NULL,
	`transports` json,
	`aaguid` varchar,
	`device_type` varchar,
	`backed_up` integer,
	`last_used_at` varchar,
	`created_at` varchar NOT NULL,
	`updated_at` varchar NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `credential_user_id_idx` ON `credential` (`user_id`);--> statement-breakpoint
CREATE TABLE `invite` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` varchar NOT NULL,
	`expires_at` varchar NOT NULL,
	`created_at` varchar NOT NULL,
	`updated_at` varchar NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_token_unique` ON `invite` (`token`);--> statement-breakpoint
CREATE INDEX `invite_user_id_idx` ON `invite` (`user_id`);