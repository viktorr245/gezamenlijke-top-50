import type { APIRoute } from "astro";
import { AuthorizationError, requireOrganizer } from "../../../server/auth";
import { ensureBurnPackages, loadFinalBurnContext, retryBurnPackages } from "../../../server/burn-packages";
import { isSameOrigin } from "../../../server/request-security";

export const prerender = false;

function burnErrorStatus(error: unknown): number {
  if (error instanceof AuthorizationError) return error.status;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("nog niet definitief") || message.includes("nog niet vast") || message.includes("hoort niet meer")) return 409;
  if (message.includes("opslaglimiet") || message.includes("schijfruimte")) return 507;
  return 500;
}

function errorResponse(error: unknown, status = burnErrorStatus(error)) {
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
  if (!isSameOrigin(request)) return errorResponse("Ongeldige aanvraag.", 403);
  try {
    const body = await request.json().catch(() => ({})) as { memberId?: unknown };
    requireOrganizer(request, body.memberId);
    const { layout, tracks } = await loadFinalBurnContext();
    return Response.json({ packages: await retryBurnPackages(layout, tracks) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
};
