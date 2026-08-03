import type { APIRoute } from "astro";
import { AuthorizationError, isAuthenticationEnabled, requireOrganizer } from "../../server/auth";
import { getStorageHealth } from "../../server/storage-health";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const memberId = new URL(request.url).searchParams.get("memberId");
    requireOrganizer(request, isAuthenticationEnabled() ? undefined : memberId);
    return Response.json({ storage: await getStorageHealth() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "De opslagstatus kon niet worden geladen." },
      { status: error instanceof AuthorizationError ? error.status : 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};
