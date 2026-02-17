"use server";

import { redirect } from "next/navigation";
import { startOfDay, subDays, format } from "date-fns";
import { prisma } from "@/lib/prisma";
import { getSession, getSessionTimeoutMinutes } from "@/lib/auth";
import type { PresenceStatus } from "@prisma/client";
import {
  calculateSessions,
  clipSessionsToRange,
  sumDurationMinutes,
  type PresenceEventLike,
} from "@/lib/presence-service";

const LOOKBACK_MS = 24 * 60 * 60 * 1000; // 1 day

export async function getOverviewStats(days: number = 30) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") redirect("/login");

  const now = new Date();
  const todayStart = startOfDay(now);
  const rangeStart = subDays(todayStart, days);
  const timeoutMinutes = await getSessionTimeoutMinutes();

  const userIds = await prisma.user
    .findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true },
    })
    .then((u) => u.map((x) => x.id));

  if (userIds.length === 0) {
    return {
      currentInOffice: 0,
      totalHoursToday: 0,
      activeEmployeesCount: 0,
      averageHoursToday: 0,
      hoursPerDay: [] as { date: string; totalHours: number }[],
    };
  }

  // Single query: events from (todayStart - lookback) to now for today + current status
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
    // Current status: IN_OFFICE only if last session end is within timeout (not stale)
    if (
      lastSession &&
      lastSession.end.getTime() >= now.getTime() - timeoutMinutes * 60 * 1000
    ) {
      currentInOffice++;
    }
  }

  const activeCount = userIds.length;
  const averageHoursToday = activeCount > 0 ? totalMinutesToday / 60 / activeCount : 0;

  // Single query for chart: full range + lookback, then group by day in code
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

  const oneDayMs = 24 * 60 * 60 * 1000;
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

  return {
    currentInOffice,
    totalHoursToday: Math.round((totalMinutesToday / 60) * 10) / 10,
    activeEmployeesCount: activeCount,
    averageHoursToday: Math.round(averageHoursToday * 10) / 10,
    hoursPerDay,
  };
}
