import { NextResponse } from "next/server";
import { startOfDay, startOfWeek, subDays } from "date-fns";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getSessionTimeoutMinutes } from "@/lib/auth";
import type { PresenceStatus } from "@prisma/client";
import {
  calculateSessions,
  clipSessionsToRange,
  sumDurationMinutes,
  type PresenceEventLike,
} from "@/lib/presence-service";

const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin();
  } catch (res) {
    return res as NextResponse;
  }

  const now = new Date();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const timeoutMinutes = await getSessionTimeoutMinutes();

  const users = await prisma.user.findMany({
    where: { deletedAt: null, role: "EMPLOYEE" },
    select: { id: true, name: true, email: true },
  });

  const userIds = users.map((u) => u.id);
  if (userIds.length === 0) {
    return NextResponse.json({ employees: [] });
  }

  const lookbackStart = new Date(Math.min(todayStart.getTime(), weekStart.getTime()) - LOOKBACK_MS);
  const events = await prisma.presenceEvent.findMany({
    where: {
      userId: { in: userIds },
      timestamp: { gte: lookbackStart },
    },
    orderBy: { timestamp: "asc" },
    select: { userId: true, timestamp: true, status: true },
  });

  const byUser = new Map<string, PresenceEventLike[]>();
  for (const e of events) {
    if (!byUser.has(e.userId)) byUser.set(e.userId, []);
    byUser.get(e.userId)!.push({ timestamp: e.timestamp, status: e.status as PresenceStatus });
  }

  const result = users.map((user) => {
    const userEvents = byUser.get(user.id) ?? [];
    const { sessions } = calculateSessions(userEvents, now, timeoutMinutes);
    const todayClipped = clipSessionsToRange(sessions, todayStart, now);
    const weekClipped = clipSessionsToRange(sessions, weekStart, now);
    const todayMinutes = sumDurationMinutes(todayClipped);
    const weekMinutes = sumDurationMinutes(weekClipped);

    const lastEvent = userEvents[userEvents.length - 1];
    let currentStatus: "IN_OFFICE" | "OUT_OF_OFFICE" | "UNKNOWN" = "UNKNOWN";
    if (lastEvent) {
      const lastSession = sessions[sessions.length - 1];
      if (
        lastSession &&
        lastSession.end.getTime() >= now.getTime() - timeoutMinutes * 60 * 1000
      ) {
        currentStatus = "IN_OFFICE";
      } else {
        currentStatus = lastEvent.status === "IN_OFFICE" ? "OUT_OF_OFFICE" : (lastEvent.status as "UNKNOWN");
      }
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      currentStatus,
      lastSeen: lastEvent?.timestamp ?? null,
      todayHours: Math.round((todayMinutes / 60) * 10) / 10,
      weekHours: Math.round((weekMinutes / 60) * 10) / 10,
    };
  });

  return NextResponse.json({ employees: result });
}
