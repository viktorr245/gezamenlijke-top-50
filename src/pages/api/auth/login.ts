import type { APIRoute } from "astro";
import { AuthorizationError, isAuthenticationEnabled, sessionCookie, verifyPin } from "../../../server/auth";
import { isSameOrigin } from "../../../server/request-security";

export const prerender = false;

type Attempt = { count: number; resetAt: number };
const attempts = new Map<string, Attempt>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const MAX_TRACKED_ATTEMPTS = 1_000;
const MAX_LOGIN_BODY_BYTES = 4 * 1024;

class LoginBodyError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function readLoginBody(request: Request): Promise<{ memberId?: unknown; pin?: unknown }> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGIN_BODY_BYTES) {
    throw new LoginBodyError("De aanmeldingsaanvraag is te groot.", 413);
  }
  if (!request.body) throw new LoginBodyError("De aanmeldingsaanvraag bevat geen geldige JSON.", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_LOGIN_BODY_BYTES) {
      await reader.cancel();
      throw new LoginBodyError("De aanmeldingsaanvraag is te groot.", 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as { memberId?: unknown; pin?: unknown };
  } catch {
    throw new LoginBodyError("De aanmeldingsaanvraag bevat geen geldige JSON.", 400);
  }
}

function attemptKey(address: string | undefined, memberId: unknown): string {
  const normalizedMember = typeof memberId === "string" && memberId.length <= 20 ? memberId : "onbekend";
  return `${(address || "local").slice(0, 100)}:${normalizedMember}`;
}

function clientAddressFor(request: Request, clientAddress: string | undefined): string | undefined {
  if (process.env.TRUST_PROXY !== "true") return clientAddress;
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || clientAddress;
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

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!isSameOrigin(request)) return Response.json({ error: "Ongeldige aanmeldpoging." }, { status: 403 });
  if (!isAuthenticationEnabled()) return Response.json({ error: "Pincode-login is niet ingesteld." }, { status: 404 });
  try {
    const body = await readLoginBody(request);
    const key = attemptKey(clientAddressFor(request, clientAddress), body.memberId);
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
    const status = error instanceof AuthorizationError || error instanceof LoginBodyError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "Aanmelden is mislukt." },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};
