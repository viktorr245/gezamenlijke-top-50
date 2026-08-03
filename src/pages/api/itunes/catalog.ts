import type { APIRoute } from "astro";
import { listPinnedITunesTracks, pinITunesTrack } from "../../../server/itunes-cache";
import { isSameOrigin } from "../../../server/request-security";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    return Response.json(
      { tracks: await listPinnedITunesTracks() },
      { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" } },
    );
  } catch {
    return Response.json({ error: "De nummercatalogus kon niet worden geladen." }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!isSameOrigin(request)) return Response.json({ error: "Ongeldige opslagaanvraag." }, { status: 403 });
  try {
    const body = await request.json() as { sourceId?: unknown };
    const track = await pinITunesTrack(typeof body.sourceId === "string" ? body.sourceId : "");
    return Response.json({ track }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Het nummer kon niet worden opgeslagen." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
};
