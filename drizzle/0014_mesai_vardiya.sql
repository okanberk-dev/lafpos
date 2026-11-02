CREATE TABLE `shift_counts` (
	`id` text PRIMARY KEY NOT NULL,
	`day_id` text NOT NULL,
	`user_id` text NOT NULL,
	`to_user_id` text,
	`confirmed` integer DEFAULT false NOT NULL,
	`counted` integer NOT NULL,
	`expected` integer NOT NULL,
	`diff` integer NOT NULL,
	`banknotes` text,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`day_id`) REFERENCES `business_days`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shift_counts_day_idx` ON `shift_counts` (`day_id`);--> statement-breakpoint
CREATE TABLE `time_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`clock_in` integer NOT NULL,
	`clock_out` integer,
	`business_date` text NOT NULL,
	`note` text,
	`source` text NOT NULL,
	`edited_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`edited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `time_entries_user_idx` ON `time_entries` (`user_id`,`clock_in`);--> statement-breakpoint
CREATE INDEX `time_entries_date_idx` ON `time_entries` (`business_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `time_entries_open_idx` ON `time_entries` (`user_id`) WHERE clock_out IS NULL;