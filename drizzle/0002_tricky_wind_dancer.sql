PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`event_type` text NOT NULL,
	`message` text NOT NULL,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_job_events`("id", "job_id", "event_type", "message", "timestamp") SELECT "id", "job_id", "event_type", "message", "timestamp" FROM `job_events`;--> statement-breakpoint
DROP TABLE `job_events`;--> statement-breakpoint
ALTER TABLE `__new_job_events` RENAME TO `job_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;