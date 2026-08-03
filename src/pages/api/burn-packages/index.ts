import type { APIRoute } from "astro";
import { ensureBurnPackages, loadFinalBurnContext, retryBurnPackages } from "../../../server/burn-packages";

export const prerender = false;

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

function errorResponse(error: unknown, status = 400) {
  return Response.json(
    { error: error instanceof Error ? error.message : typeof error === "string" ? error : "De brandpakketten konden niet worden geladen." },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET: APIRoute = async () => {
  try {
    const { layout, tracks } = await loadFinalBurnContext();
    return Response.json({ packages: await ensureBurnPackages(layout, tracks) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return errorResponse("Ongeldige aanvraag.", 403);
  try {
    const body = await request.json().catch(() => ({})) as { memberId?: unknown };
    if (body.memberId !== "viktor") return errorResponse("Alleen Viktor kan de brandpakketten opnieuw laten maken.", 403);
    const { layout, tracks } = await loadFinalBurnContext();
    return Response.json({ packages: await retryBurnPackages(layout, tracks) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
};
