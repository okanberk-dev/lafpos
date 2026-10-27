ALTER TABLE `tables` ADD `qr_code` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tables_qr_code_idx` ON `tables` (`qr_code`);