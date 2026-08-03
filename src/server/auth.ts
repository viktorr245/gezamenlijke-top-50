import { createHmac, timingSafeEqual } from "node:crypto";
import { isMemberId, members, type MemberId } from "../data/tracks";

const COOKIE_NAME = "gezamenlijke_top_50_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

export class AuthorizationError extends Error {
  constructor(message: string, public readonly status = 403) {
    super(message);
  }
}

function pinConfiguration(): Partial<Record<MemberId, string>> | null {
  const raw = process.env.MEMBER_PINS?.trim();
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("MEMBER_PINS moet geldige JSON zijn.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MEMBER_PINS moet een JSON-object met deelnemers en pincodes zijn.");
  }
  const pins: Partial<Record<MemberId, string>> = {};
  for (const [memberId, pin] of Object.entries(value)) {
    if (isMemberId(memberId) && typeof pin === "string" && pin.length >= 4) pins[memberId] = pin;
  }
  if (members.some((member) => !pins[member.id])) {
    throw new Error("MEMBER_PINS moet voor alle vijf deelnemers een pincode van minimaal vier tekens bevatten.");
  }
  if (new Set(Object.values(pins)).size !== members.length) {
    throw new Error("Iedere deelnemer moet een eigen pincode hebben.");
  }
  return pins;
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET ?? "";
  if (secret.length < 32) throw new Error("AUTH_SECRET moet bij pincode-login minimaal 32 tekens lang zijn.");
  return secret;
}

function signature(value: string): string {
  return createHmac("sha256", authSecret()).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(request: Request): string | undefined {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function isAuthenticationEnabled(): boolean {
  return pinConfiguration() !== null;
}

export function authenticatedMember(request: Request): MemberId | undefined {
  if (!isAuthenticationEnabled()) return undefined;
  const value = cookieValue(request);
  if (!value) return undefined;
  const [memberId, expiresAtValue, suppliedSignature] = value.split(".");
  if (!isMemberId(memberId) || !expiresAtValue || !suppliedSignature) return undefined;
  const expiresAt = Number(expiresAtValue);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return undefined;
  const payload = `${memberId}.${expiresAtValue}`;
  return safeEqual(signature(payload), suppliedSignature) ? memberId : undefined;
}

export function verifyPin(memberIdValue: unknown, pinValue: unknown): MemberId {
  if (!isMemberId(memberIdValue) || typeof pinValue !== "string") {
    throw new AuthorizationError("Controleer je naam en pincode.", 401);
  }
  const expected = pinConfiguration()?.[memberIdValue];
  if (!expected || !safeEqual(expected, pinValue)) {
    throw new AuthorizationError("Controleer je naam en pincode.", 401);
  }
  return memberIdValue;
}

export function sessionCookie(memberId: MemberId, request: Request): string {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `${memberId}.${expiresAt}`;
  const value = `${payload}.${signature(payload)}`;
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
}

export function expiredSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function requireMember(request: Request, requestedMember: unknown): MemberId {
  if (!isMemberId(requestedMember)) throw new AuthorizationError("Onbekende deelnemer.", 400);
  if (!isAuthenticationEnabled()) return requestedMember;
  const current = authenticatedMember(request);
  if (!current) throw new AuthorizationError("Meld je opnieuw aan.", 401);
  if (current !== requestedMember) throw new AuthorizationError("Je kunt alleen je eigen gegevens aanpassen.");
  return current;
}

export function requireOrganizer(request: Request, trustedModeMember?: unknown): MemberId {
  if (!isAuthenticationEnabled()) {
    if (trustedModeMember !== "viktor") throw new AuthorizationError("Alleen Viktor kan dit doen.");
    return "viktor";
  }
  const current = authenticatedMember(request);
  if (!current) throw new AuthorizationError("Meld je opnieuw aan.", 401);
  if (current !== "viktor") throw new AuthorizationError("Alleen Viktor kan dit doen.");
  return current;
}
