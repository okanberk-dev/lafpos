ALTER TABLE `business_days` ADD `worked_user_ids` text;--> statement-breakpoint
ALTER TABLE `users` ADD `staff_ref` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_staff_ref_idx` ON `users` (`staff_ref`) WHERE staff_ref IS NOT NULL;