-- WhatsApp as a way to reach people: the number they use it on, and the
-- owner's preferred channel per contact (null = decide from recent traffic).
-- Idempotent, applied before every build: see scripts/migrate-additive.ts.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "whatsapp_phone" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "preferred_channel" text;
