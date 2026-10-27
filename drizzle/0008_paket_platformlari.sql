CREATE TABLE `platform_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`external_id` text NOT NULL,
	`status` text DEFAULT 'bekliyor' NOT NULL,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL,
	`expires_at` integer,
	`order_id` text,
	`decided_at` integer,
	`decided_by` text,
	`reason` text,
	`last_error` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_orders_ext_idx` ON `platform_orders` (`platform`,`external_id`);--> statement-breakpoint
CREATE INDEX `platform_orders_status_idx` ON `platform_orders` (`status`);--> statement-breakpoint
ALTER TABLE `orders` ADD `platform` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `platform_code` text;