CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`user_id` text,
	`approver_id` text,
	`action` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`order_id` text,
	`entity` text,
	`entity_id` text,
	`amount` integer,
	`message` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_severity_idx` ON `audit_log` (`severity`,`at`);--> statement-breakpoint
CREATE TABLE `business_days` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`z_no` integer NOT NULL,
	`opened_at` integer NOT NULL,
	`opened_by` text,
	`opening_cash` integer DEFAULT 0 NOT NULL,
	`closed_at` integer,
	`closed_by` text,
	`counted_cash` integer,
	`cash_counts` text,
	`expected_cash` integer,
	`cash_diff` integer,
	`note` text,
	`summary` text,
	`last_order_no` integer DEFAULT 0 NOT NULL,
	`exported_at` integer,
	FOREIGN KEY (`opened_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `business_days_date_idx` ON `business_days` (`date`);--> statement-breakpoint
CREATE TABLE `cash_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`day_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`day_id`) REFERENCES `business_days`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cash_movements_day_idx` ON `cash_movements` (`day_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`subtitle` text,
	`color` text DEFAULT '#245c43' NOT NULL,
	`icon` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`station_id` text,
	`customizable` integer DEFAULT true NOT NULL,
	`ext_source` text,
	`ext_key` text,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_ext_idx` ON `categories` (`ext_source`,`ext_key`);--> statement-breakpoint
CREATE TABLE `customer_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`title` text DEFAULT 'Ev' NOT NULL,
	`address` text NOT NULL,
	`note` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `customer_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`order_id` text,
	`payment_id` text,
	`method_id` text,
	`day_id` text,
	`note` text,
	`user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_ledger_customer_idx` ON `customer_ledger` (`customer_id`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`email` text,
	`note` text,
	`birthday` text,
	`balance` integer DEFAULT 0 NOT NULL,
	`credit_limit` integer,
	`stamps` integer DEFAULT 0 NOT NULL,
	`total_spent` integer DEFAULT 0 NOT NULL,
	`visits` integer DEFAULT 0 NOT NULL,
	`last_visit_at` integer,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_phone_idx` ON `customers` (`phone`);--> statement-breakpoint
CREATE TABLE `happy_hours` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`days` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`percent` integer NOT NULL,
	`category_ids` text DEFAULT '[]' NOT NULL,
	`product_ids` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `option_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'single' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`max_select` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`ext_source` text,
	`ext_key` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `option_groups_ext_idx` ON `option_groups` (`ext_source`,`ext_key`);--> statement-breakpoint
CREATE TABLE `option_items` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`price` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`max_qty` integer DEFAULT 1 NOT NULL,
	`allergens` text DEFAULT '[]' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `option_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `option_items_group_idx` ON `option_items` (`group_id`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text,
	`name` text NOT NULL,
	`size` text DEFAULT 'TEK' NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`options_text` text DEFAULT '' NOT NULL,
	`qty` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`base_price` integer NOT NULL,
	`kdv_rate` integer NOT NULL,
	`discount` integer DEFAULT 0 NOT NULL,
	`discount_reason` text,
	`happy_hour` integer DEFAULT false NOT NULL,
	`complimentary` integer DEFAULT false NOT NULL,
	`comp_reason` text,
	`comp_by` text,
	`voided` integer DEFAULT false NOT NULL,
	`void_reason` text,
	`void_by` text,
	`void_approved_by` text,
	`voided_at` integer,
	`void_after_send` integer DEFAULT false NOT NULL,
	`note` text,
	`station_id` text,
	`status` text DEFAULT 'yeni' NOT NULL,
	`batch` integer DEFAULT 1 NOT NULL,
	`sent_at` integer NOT NULL,
	`started_at` integer,
	`ready_at` integer,
	`served_at` integer,
	`paid_qty` integer DEFAULT 0 NOT NULL,
	`is_service` integer DEFAULT false NOT NULL,
	`ext_product_id` text,
	`pos_name` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_status_idx` ON `order_items` (`status`,`station_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`day_id` text NOT NULL,
	`no` integer NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'acik' NOT NULL,
	`table_id` text,
	`customer_id` text,
	`waiter_id` text,
	`guests` integer DEFAULT 1 NOT NULL,
	`note` text,
	`opened_at` integer NOT NULL,
	`opened_by` text,
	`closed_at` integer,
	`closed_by` text,
	`discount_type` text,
	`discount_value` integer,
	`discount_reason` text,
	`discount_by` text,
	`service_rate` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`paid` integer DEFAULT 0 NOT NULL,
	`totals` text,
	`bill_printed_at` integer,
	`bill_prints` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'pos' NOT NULL,
	`ext_id` text,
	`ext_no` integer,
	`ext_stage` text,
	`ext_fulfillment` text,
	`ext_label` text,
	`ext_paid` integer DEFAULT false NOT NULL,
	`ext_total` integer,
	`scheduled_for` text,
	`delivery_name` text,
	`delivery_phone` text,
	`delivery_address` text,
	`delivery_status` text,
	`courier_id` text,
	`merged_into` text,
	`cancel_reason` text,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`day_id`) REFERENCES `business_days`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`waiter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opened_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`courier_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_table_idx` ON `orders` (`table_id`,`status`);--> statement-breakpoint
CREATE INDEX `orders_day_idx` ON `orders` (`day_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_ext_idx` ON `orders` (`source`,`ext_id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target` text NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`sent_at`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `payment_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`z_field` text NOT NULL,
	`channel` text,
	`color` text DEFAULT '#245c43' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text,
	`day_id` text NOT NULL,
	`method_id` text NOT NULL,
	`method_name` text NOT NULL,
	`z_field` text NOT NULL,
	`amount` integer NOT NULL,
	`tip` integer DEFAULT 0 NOT NULL,
	`given` integer,
	`change` integer,
	`items` text,
	`customer_id` text,
	`note` text,
	`user_id` text,
	`created_at` integer NOT NULL,
	`refunded_at` integer,
	`refunded_by` text,
	`refund_reason` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `business_days`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `payments_day_idx` ON `payments` (`day_id`);--> statement-breakpoint
CREATE TABLE `printers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'tarayici' NOT NULL,
	`host` text,
	`port` integer DEFAULT 9100 NOT NULL,
	`width_mm` integer DEFAULT 80 NOT NULL,
	`copies` integer DEFAULT 1 NOT NULL,
	`docs` text DEFAULT '["adisyon"]' NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_option_groups` (
	`product_id` text NOT NULL,
	`group_id` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`product_id`, `group_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `option_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`name` text NOT NULL,
	`short_name` text,
	`description` text,
	`price` integer NOT NULL,
	`price_l` integer,
	`kdv_rate` integer DEFAULT 10 NOT NULL,
	`station_id` text,
	`color` text,
	`image` text,
	`active` integer DEFAULT true NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`allergens` text,
	`barcode` text,
	`pos_name` text,
	`is_service` integer DEFAULT false NOT NULL,
	`portions_left` integer,
	`cost` integer,
	`ext_source` text,
	`ext_id` text,
	`ext_hash` text,
	`synced_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_ext_idx` ON `products` (`ext_source`,`ext_id`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`time` text NOT NULL,
	`duration_min` integer DEFAULT 120 NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`guests` integer DEFAULT 2 NOT NULL,
	`table_id` text,
	`customer_id` text,
	`status` text DEFAULT 'bekliyor' NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `reservations_date_idx` ON `reservations` (`date`);--> statement-breakpoint
CREATE TABLE `room_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`table_id` text NOT NULL,
	`hourly_rate` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`item_id` text,
	`started_by` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'bar' NOT NULL,
	`color` text DEFAULT '#245c43' NOT NULL,
	`printer_id` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tables` (
	`id` text PRIMARY KEY NOT NULL,
	`section_id` text NOT NULL,
	`name` text NOT NULL,
	`seats` integer DEFAULT 2 NOT NULL,
	`shape` text DEFAULT 'square' NOT NULL,
	`x` real DEFAULT 0 NOT NULL,
	`y` real DEFAULT 0 NOT NULL,
	`w` real DEFAULT 10 NOT NULL,
	`h` real DEFAULT 10 NOT NULL,
	`kind` text DEFAULT 'masa' NOT NULL,
	`hourly_rate` integer,
	`site_table_code` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tables_section_idx` ON `tables` (`section_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`pin_hash` text NOT NULL,
	`color` text DEFAULT '#245c43' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`perm_grant` text DEFAULT '[]' NOT NULL,
	`perm_revoke` text DEFAULT '[]' NOT NULL,
	`max_discount_pct` integer DEFAULT 100 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_pin_hash_unique` ON `users` (`pin_hash`);