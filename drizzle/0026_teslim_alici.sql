ALTER TABLE `cash_movements` ADD `recipient_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `cash_movements` ADD `recipient_name` text;