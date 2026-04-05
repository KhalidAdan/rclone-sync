CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`destination_path` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`rclone_job_id` integer,
	`error` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
