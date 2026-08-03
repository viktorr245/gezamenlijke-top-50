import type { APIRoute } from "astro";
import { authenticatedMember, isAuthenticationEnabled } from "../../../server/auth";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => Response.json({
  enabled: isAuthenticationEnabled(),
  memberId: authenticatedMember(request) ?? null,
}, { headers: { "Cache-Control": "no-store" } });
