PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_job` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` varchar NOT NULL,
	`spec` json NOT NULL,
	`state` varchar NOT NULL,
	`result` json,
	`error` json,
	`status` json,
	`queued_at` varchar NOT NULL,
	`working_at` varchar,
	`ok_at` varchar,
	`error_at` varchar,
	`created_at` varchar NOT NULL,
	`updated_at` varchar NOT NULL,
	CONSTRAINT "job_state_consistent" CHECK(("__new_job"."state" = 'queued' AND "__new_job"."result" IS NULL AND "__new_job"."error" IS NULL)
        OR ("__new_job"."state" = 'working' AND "__new_job"."result" IS NULL AND "__new_job"."error" IS NULL)
        OR ("__new_job"."state" = 'ok' AND "__new_job"."result" IS NOT NULL AND "__new_job"."error" IS NULL)
        OR ("__new_job"."state" = 'error' AND "__new_job"."result" IS NULL AND "__new_job"."error" IS NOT NULL)),
	CONSTRAINT "job_json_not_null_literal" CHECK("__new_job"."spec" <> 'null'
        AND ("__new_job"."result" IS NULL OR "__new_job"."result" <> 'null')
        AND ("__new_job"."error" IS NULL OR "__new_job"."error" <> 'null')
        AND ("__new_job"."status" IS NULL OR "__new_job"."status" <> 'null'))
);
--> statement-breakpoint
INSERT INTO `__new_job`("id", "job_type", "spec", "state", "result", "error", "status", "queued_at", "working_at", "ok_at", "error_at", "created_at", "updated_at") SELECT "id", "job_type", "spec", CASE WHEN "state" = 'running' THEN 'working' ELSE "state" END, "result", "error", "status", "created_at", "created_at", CASE WHEN "state" = 'ok' THEN "updated_at" ELSE NULL END, CASE WHEN "state" = 'error' THEN "updated_at" ELSE NULL END, "created_at", "updated_at" FROM `job`;--> statement-breakpoint
DROP TABLE `job`;--> statement-breakpoint
ALTER TABLE `__new_job` RENAME TO `job`;--> statement-breakpoint
PRAGMA defer_foreign_keys = false;--> statement-breakpoint
CREATE INDEX `job_type_idx` ON `job` (`job_type`);