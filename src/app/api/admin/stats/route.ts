import { NextResponse } from "next/server";
import { startOfDay, subDays, format } from "date-fns";
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

  const { searchParams } = new URL(request.url);
  const days = Math.min(90, Math.max(7, parseInt(searchParams.get("days") ?? "30", 10) || 30));

  const now = new Date();
  const todayStart = startOfDay(now);
  const rangeStart = subDays(todayStart, days);
  const timeoutMinutes = await getSessionTimeoutMinutes();

  const userIds = await prisma.user.findMany({
    where: { deletedAt: null, isActive: true },
    select: { id: true },
  }).then((u) => u.map((x) => x.id));

  if (userIds.length === 0) {
    return NextResponse.json({
      currentInOffice: 0,
      totalHoursToday: 0,
      activeEmployeesCount: 0,
      averageHoursToday: 0,
      hoursPerDay: [],
    });
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  const todayLookbackStart = new Date(todayStart.getTime() - LOOKBACK_MS);

  const eventsForToday = await prisma.presenceEvent.findMany({
    where: {
      userId: { in: userIds },
      timestamp: { gte: todayLookbackStart, lte: now },
    },
    orderBy: { timestamp: "asc" },
    select: { userId: true, timestamp: true, status: true },
  });

  const byUserToday = new Map<string, PresenceEventLike[]>();
  for (const e of eventsForToday) {
    if (!byUserToday.has(e.userId)) byUserToday.set(e.userId, []);
    byUserToday.get(e.userId)!.push({ timestamp: e.timestamp, status: e.status as PresenceStatus });
  }

  let totalMinutesToday = 0;
  let currentInOffice = 0;
  for (const userId of userIds) {
    const userEvents = byUserToday.get(userId) ?? [];
    const { sessions } = calculateSessions(userEvents, now, timeoutMinutes);
    const todayClipped = clipSessionsToRange(sessions, todayStart, now);
    totalMinutesToday += sumDurationMinutes(todayClipped);
    const lastSession = sessions[sessions.length - 1];
    if (lastSession && lastSession.end.getTime() >= now.getTime() - timeoutMinutes * 60 * 1000) {
      currentInOffice++;
    }
  }

  const activeCount = userIds.length;
  const averageHoursToday = activeCount > 0 ? totalMinutesToday / 60 / activeCount : 0;

  const chartRangeStart = new Date(rangeStart.getTime() - LOOKBACK_MS);
  const allChartEvents = await prisma.presenceEvent.findMany({
    where: {
      userId: { in: userIds },
      timestamp: { gte: chartRangeStart, lte: now },
    },
    orderBy: { timestamp: "asc" },
    select: { userId: true, timestamp: true, status: true },
  });

  const byUserChart = new Map<string, PresenceEventLike[]>();
  for (const e of allChartEvents) {
    if (!byUserChart.has(e.userId)) byUserChart.set(e.userId, []);
    byUserChart.get(e.userId)!.push({ timestamp: e.timestamp, status: e.status as PresenceStatus });
  }

  const hoursPerDay: { date: string; totalHours: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = subDays(todayStart, i);
    const dayEnd = new Date(d.getTime() + oneDayMs - 1);
    let dayTotal = 0;
    for (const userId of userIds) {
      const userEvents = byUserChart.get(userId) ?? [];
      const dayEvents = userEvents.filter(
        (e) => e.timestamp >= new Date(d.getTime() - LOOKBACK_MS) && e.timestamp <= dayEnd
      );
      const { sessions } = calculateSessions(dayEvents, dayEnd, timeoutMinutes);
      const clipped = clipSessionsToRange(sessions, d, dayEnd);
      dayTotal += sumDurationMinutes(clipped);
    }
    hoursPerDay.push({
      date: format(d, "yyyy-MM-dd"),
      totalHours: Math.round((dayTotal / 60) * 10) / 10,
    });
  }

  return NextResponse.json({
    currentInOffice,
    totalHoursToday: Math.round((totalMinutesToday / 60) * 10) / 10,
    activeEmployeesCount: activeCount,
    averageHoursToday: Math.round(averageHoursToday * 10) / 10,
    hoursPerDay,
  });
}
