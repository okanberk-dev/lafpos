CREATE TABLE `fiscal_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`mode` text NOT NULL,
	`terminal_id` text,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`items` text NOT NULL,
	`basket` text NOT NULL,
	`result` text,
	`z_no` integer,
	`receipt_no` integer,
	`payment_ids` text DEFAULT '[]' NOT NULL,
	`error` text,
	`sent_by` text,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fiscal_order_idx` ON `fiscal_receipts` (`order_id`);--> statement-breakpoint
CREATE INDEX `fiscal_status_idx` ON `fiscal_receipts` (`status`);