CREATE TABLE `platform_products` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`product_id` text,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_products_ext_idx` ON `platform_products` (`platform`,`external_id`);--> statement-breakpoint
ALTER TABLE `platform_orders` ADD `notified_status` text;