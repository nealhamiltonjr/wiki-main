ALTER TABLE `attributes` ADD `value_page_id` text REFERENCES pages(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX `attributes_value_page_id_idx` ON `attributes` (`value_page_id`);
