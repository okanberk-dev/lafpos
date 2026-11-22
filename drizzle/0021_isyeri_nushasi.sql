ALTER TABLE `fiscal_receipts` ADD `store_copy` text;--> statement-breakpoint
ALTER TABLE `fiscal_receipts` ADD `store_copy_claim` text;--> statement-breakpoint
ALTER TABLE `fiscal_receipts` ADD `store_copy_at` integer;--> statement-breakpoint
CREATE INDEX `fiscal_store_copy_idx` ON `fiscal_receipts` (`store_copy`);