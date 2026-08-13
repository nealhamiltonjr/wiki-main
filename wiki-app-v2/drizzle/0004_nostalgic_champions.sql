CREATE TABLE `page_redirects` (
	`space_id` text NOT NULL,
	`old_slug` text NOT NULL,
	`page_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `old_slug`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
