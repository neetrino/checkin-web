import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  verifyPassword,
  createToken,
  setSessionCookie,
  getSessionTimeoutMinutes,
} from "@/lib/auth";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Simple in-memory rate limit: 5 attempts per IP per minute
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

export async function POST(request: Request) {
  try {
    // Fail fast with clear logs on Vercel when env is missing
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      console.error("[api/auth/login] JWT_SECRET is missing or shorter than 32 characters. Set it in Vercel → Project → Settings → Environment Variables.");
      return NextResponse.json(
        { error: "Login failed. Try again later." },
        { status: 500 }
      );
    }
    if (!process.env.DATABASE_URL) {
      console.error("[api/auth/login] DATABASE_URL is not set. Set it in Vercel → Project → Settings → Environment Variables.");
      return NextResponse.json(
        { error: "Login failed. Try again later." },
        { status: 500 }
      );
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!rateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429 }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 400 });
    }

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (
      !user ||
      user.deletedAt != null ||
      !user.isActive ||
      !(await verifyPassword(password, user.passwordHash))
    ) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    // ADMIN can use dashboard; EMPLOYEE can use mobile app and post presence
    const timeout = await getSessionTimeoutMinutes();
    const token = await createToken(user.id, user.email, user.role);
    await setSessionCookie(token);

    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      expiresIn: timeout * 60,
    });
  } catch (err) {
    console.error("[api/auth/login]", err);
    return NextResponse.json(
      { error: "Login failed. Try again later." },
      { status: 500 }
    );
  }
}
