"use server";

import { redirect } from "next/navigation";
import {
  startOfDay,
  startOfWeek,
  startOfMonth,
  subDays,
  format,
} from "date-fns";
import { prisma } from "@/lib/prisma";
import { getSession, getSessionTimeoutMinutes } from "@/lib/auth";
import {
  calculateSessions,
  clipSessionsToRange,
  sumDurationMinutes,
  type PresenceEventLike,
} from "@/lib/presence-service";

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function getEmployeeDetail(
  id: string,
  opts: { from?: string; to?: string; days?: number }
) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id, deletedAt: null },
    select: { id: true, name: true, email: true },
  });
  if (!user) return null;

  const now = new Date();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const monthStart = startOfMonth(now);
  const timeoutMinutes = await getSessionTimeoutMinutes();
  const days = Math.min(90, Math.max(1, opts.days ?? 14));

  let rangeStart: Date;
  let rangeEnd: Date;
  if (opts.from && opts.to) {
    rangeStart = new Date(opts.from);
    rangeEnd = new Date(opts.to);
  } else {
    rangeEnd = now;
    rangeStart = subDays(todayStart, days);
  }

  const summaryLookbackStart = new Date(monthStart.getTime() - LOOKBACK_MS);
  const summaryEvents = await prisma.presenceEvent.findMany({
    where: {
      userId: id,
      timestamp: { gte: summaryLookbackStart, lte: now },
    },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, status: true },
  });

  const summarySessions = calculateSessions(summaryEvents as PresenceEventLike[], now, timeoutMinutes).sessions;
  const todayClipped = clipSessionsToRange(summarySessions, todayStart, now);
  const weekClipped = clipSessionsToRange(summarySessions, weekStart, now);
  const monthClipped = clipSessionsToRange(summarySessions, monthStart, now);

  const lookbackStart = new Date(rangeStart.getTime() - LOOKBACK_MS);
  const events = await prisma.presenceEvent.findMany({
    where: {
      userId: id,
      timestamp: { gte: lookbackStart, lte: rangeEnd },
    },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, status: true },
  });

  const eventsInRange = events.filter(
    (e) => e.timestamp >= rangeStart && e.timestamp <= rangeEnd
  );

  const { sessions, totalDurationMinutes } = calculateSessions(
    eventsInRange as PresenceEventLike[],
    rangeEnd,
    timeoutMinutes
  );

  const hoursPerDay: { date: string; hours: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = subDays(todayStart, i);
    const dayEnd = new Date(d.getTime() + ONE_DAY_MS - 1);
    const dayEvents = events.filter(
      (e) => e.timestamp >= new Date(d.getTime() - LOOKBACK_MS) && e.timestamp <= dayEnd
    );
    const { sessions: daySessions } = calculateSessions(dayEvents as PresenceEventLike[], dayEnd, timeoutMinutes);
    const clipped = clipSessionsToRange(daySessions, d, dayEnd);
    const dm = sumDurationMinutes(clipped);
    hoursPerDay.push({
      date: format(d, "yyyy-MM-dd"),
      hours: Math.round((dm / 60) * 10) / 10,
    });
  }

  return {
    user: { id: user.id, name: user.name, email: user.email },
    summary: {
      todayHours: Math.round((sumDurationMinutes(todayClipped) / 60) * 10) / 10,
      weekHours: Math.round((sumDurationMinutes(weekClipped) / 60) * 10) / 10,
      monthHours: Math.round((sumDurationMinutes(monthClipped) / 60) * 10) / 10,
    },
    sessions: sessions.map((s) => ({
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      durationMinutes: Math.round(s.durationMinutes * 10) / 10,
    })),
    totalDurationMinutes: Math.round(totalDurationMinutes * 10) / 10,
    hoursPerDay,
    rawEvents: eventsInRange.map((e) => ({
      timestamp: e.timestamp.toISOString(),
      status: e.status,
    })),
  };
}
