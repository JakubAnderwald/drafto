"use client";

import { useActivityPing } from "@/hooks/use-activity-ping";

interface ActivityPingProps {
  userId: string;
}

/**
 * Records today's activity day for the signed-in user (ADR 0078). Renders nothing: it is a
 * component only so the server-rendered app layout can run the client-side ping without
 * turning `AppShell` into its owner.
 */
export function ActivityPing({ userId }: ActivityPingProps): null {
  useActivityPing(userId);
  return null;
}
