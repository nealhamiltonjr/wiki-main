CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`capabilities` text NOT NULL,
	`node_types` text NOT NULL,
	`mark_types` text NOT NULL,
	`installed_at` integer NOT NULL
);
