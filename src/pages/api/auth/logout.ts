import type { APIRoute } from "astro";
import { expiredSessionCookie } from "../../../server/auth";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => new Response(null, {
  status: 204,
  headers: { "Cache-Control": "no-store", "Set-Cookie": expiredSessionCookie(request) },
});
