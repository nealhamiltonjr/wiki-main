-- §11.3 plugin failure isolation: track consecutive handler failures so a
-- misbehaving plugin can be auto-disabled with a visible reason instead of
-- silently degrading the host app on every page load.

ALTER TABLE `plugins` ADD COLUMN `failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `plugins` ADD COLUMN `last_error` text;--> statement-breakpoint
ALTER TABLE `plugins` ADD COLUMN `last_failure_at` integer;--> statement-breakpoint
ALTER TABLE `plugins` ADD COLUMN `disabled_reason` text;
