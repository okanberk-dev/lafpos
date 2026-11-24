ALTER TABLE `business_days` ADD `expected_opening` integer;--> statement-breakpoint
ALTER TABLE `business_days` ADD `opening_diff` integer;--> statement-breakpoint
ALTER TABLE `business_days` ADD `opening_reason` text;--> statement-breakpoint
ALTER TABLE `cash_movements` ADD `category_id` integer;--> statement-breakpoint
ALTER TABLE `cash_movements` ADD `category_name` text;