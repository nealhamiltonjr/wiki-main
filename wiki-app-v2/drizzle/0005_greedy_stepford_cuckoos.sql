CREATE TABLE `saved_filters` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`criteria` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`share_token` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_filters_share_token_unique` ON `saved_filters` (`share_token`);