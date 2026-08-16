CREATE INDEX `backlinks_source_page_id_idx` ON `backlinks` (`source_page_id`);--> statement-breakpoint
CREATE INDEX `backlinks_target_branch_id_idx` ON `backlinks` (`target_branch_id`);--> statement-breakpoint
CREATE INDEX `comments_thread_id_idx` ON `comments` (`thread_id`);--> statement-breakpoint
CREATE INDEX `favorites_user_id_idx` ON `favorites` (`user_id`);--> statement-breakpoint
CREATE INDEX `files_page_id_idx` ON `files` (`page_id`);--> statement-breakpoint
CREATE INDEX `notifications_user_id_idx` ON `notifications` (`user_id`);--> statement-breakpoint
CREATE INDEX `pinned_pages_user_id_idx` ON `pinned_pages` (`user_id`);