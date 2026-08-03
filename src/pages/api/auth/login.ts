import type { APIRoute } from "astro";
import { AuthorizationError, isAuthenticationEnabled, sessionCookie, verifyPin } from "../../../server/auth";

export const prerender = false;

type Attempt = { count: number; resetAt: number };
const attempts = new Map<string, Attempt>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const MAX_TRACKED_ATTEMPTS = 1_000;

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

function attemptKey(request: Request, memberId: unknown): string {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
  const normalizedMember = typeof memberId === "string" && memberId.length <= 20 ? memberId : "onbekend";
  return `${address.slice(0, 100)}:${normalizedMember}`;
}

function pruneAttempts(now: number) {
  for (const [key, attempt] of attempts) {
    if (attempt.resetAt <= now) attempts.delete(key);
  }
  while (attempts.size >= MAX_TRACKED_ATTEMPTS) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return Response.json({ error: "Ongeldige aanmeldpoging." }, { status: 403 });
  if (!isAuthenticationEnabled()) return Response.json({ error: "Pincode-login is niet ingesteld." }, { status: 404 });
  try {
    const body = await request.json() as { memberId?: unknown; pin?: unknown };
    const key = attemptKey(request, body.memberId);
    const now = Date.now();
    pruneAttempts(now);
    const attempt = attempts.get(key);
    if (attempt && attempt.resetAt > now && attempt.count >= MAX_ATTEMPTS) {
      throw new AuthorizationError("Te veel pogingen. Probeer het over vijftien minuten opnieuw.", 429);
    }
    try {
      const memberId = verifyPin(body.memberId, body.pin);
      attempts.delete(key);
      return Response.json(
        { memberId },
        { headers: { "Cache-Control": "no-store", "Set-Cookie": sessionCookie(memberId, request) } },
      );
    } catch (error) {
      attempts.set(key, {
        count: attempt?.resetAt && attempt.resetAt > now ? attempt.count + 1 : 1,
        resetAt: attempt?.resetAt && attempt.resetAt > now ? attempt.resetAt : now + WINDOW_MS,
      });
      throw error;
    }
  } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "Aanmelden is mislukt." },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};
