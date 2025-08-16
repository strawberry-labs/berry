CREATE INDEX IF NOT EXISTS "chat_userId_idx" ON "Chat" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_createdAt_idx" ON "Chat" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_chatId_idx" ON "Message_v2" USING btree ("chatId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_role_idx" ON "Message_v2" USING btree ("role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_createdAt_idx" ON "Message_v2" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_role_createdAt_chat_idx" ON "Message_v2" USING btree ("role","createdAt","chatId");