-- course_set loses its stored front/back disposition (derived from hole
-- numbers where needed) and gains explicit USGA provenance: usga_course_id +
-- usga_course_nine say "this nine is the front/back half of THIS rated
-- 18-hole course". Hand-rewritten from drizzle-kit output to RENAME
-- ncrdb_course_id (same data, new name) instead of dropping it; existing
-- links were all recorded against the combo the nine fronts, so they
-- backfill as 'front'.
ALTER TABLE `course_set` DROP COLUMN `disposition`;--> statement-breakpoint
ALTER TABLE `course_set` RENAME COLUMN `ncrdb_course_id` TO `usga_course_id`;--> statement-breakpoint
ALTER TABLE `course_set` ADD `usga_course_nine` varchar;--> statement-breakpoint
UPDATE `course_set` SET usga_course_nine = 'front' WHERE usga_course_id IS NOT NULL;
