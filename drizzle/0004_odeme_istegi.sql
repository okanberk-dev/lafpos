ALTER TABLE `payments` ADD `request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `payments_request_idx` ON `payments` (`order_id`,`request_id`);