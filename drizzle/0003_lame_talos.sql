ALTER TABLE `jobs` ADD `downloaded_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `origin` text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `archived_as` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `m4b_size_bytes` integer;