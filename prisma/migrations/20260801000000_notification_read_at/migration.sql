-- Adds an in-app "read" marker to notifications, distinct from delivery status.
ALTER TABLE "notifications" ADD COLUMN "readAt" TIMESTAMP(3);
