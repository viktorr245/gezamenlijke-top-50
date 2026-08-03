import type { APIRoute } from "astro";
import { expiredSessionCookie } from "../../../server/auth";
import { isSameOrigin } from "../../../server/request-security";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Ongeldige afmeldpoging." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", "Set-Cookie": expiredSessionCookie(request) },
  });
};
