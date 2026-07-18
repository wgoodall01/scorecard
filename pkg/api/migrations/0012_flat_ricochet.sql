CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` varchar NOT NULL,
	`spec` json NOT NULL,
	`state` varchar NOT NULL,
	`result` json,
	`error` json,
	`status` json,
	`created_at` varchar NOT NULL,
	`updated_at` varchar NOT NULL,
	CONSTRAINT "job_state_consistent" CHECK(("job"."state" = 'running' AND "job"."result" IS NULL AND "job"."error" IS NULL)
        OR ("job"."state" = 'ok' AND "job"."result" IS NOT NULL AND "job"."error" IS NULL)
        OR ("job"."state" = 'error' AND "job"."result" IS NULL AND "job"."error" IS NOT NULL)),
	CONSTRAINT "job_json_not_null_literal" CHECK("job"."spec" <> 'null'
        AND ("job"."result" IS NULL OR "job"."result" <> 'null')
        AND ("job"."error" IS NULL OR "job"."error" <> 'null')
        AND ("job"."status" IS NULL OR "job"."status" <> 'null'))
);
--> statement-breakpoint
CREATE INDEX `job_type_idx` ON `job` (`job_type`);--> statement-breakpoint
ALTER TABLE `scorecard` ADD `extract_score_job_id` text REFERENCES job(id);--> statement-breakpoint
ALTER TABLE `scorecard` DROP COLUMN `scores_extract`;--> statement-breakpoint
ALTER TABLE `scorecard` DROP COLUMN `scores_error`;