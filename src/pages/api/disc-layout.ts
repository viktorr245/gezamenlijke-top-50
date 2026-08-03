import type { APIRoute } from "astro";
import { AuthorizationError, requireOrganizer } from "../../server/auth";
import { ensureBurnPackages, resolveBurnAudioSources, validateBurnCapacity } from "../../server/burn-packages";
import { finalizeDiscLayout, getDiscLayout, saveDiscLayout } from "../../server/disc-layout-storage";
import { loadGroupData } from "../../server/group-state";
import { calculateRanking } from "../../server/ranking";
import { isSameOrigin } from "../../server/request-security";

export const prerender = false;

function errorResponse(error: unknown, fallbackStatus = 400) {
  const message = error instanceof Error ? error.message : "De cd-indeling kon niet worden opgeslagen.";
  return Response.json({ error: message }, { status: error instanceof AuthorizationError ? error.status : message.includes("al definitief") ? 409 : message.includes("schijfruimte") || message.includes("opslaglimiet") ? 507 : fallbackStatus, headers: { "Cache-Control": "no-store" } });
}

async function rankingData() {
  const group = await loadGroupData();
  if (!group.status.votingComplete) return { group, ranking: null, topTracks: [] };
  const ranking = calculateRanking(group.tracks, Object.values(group.voteChoices).flat());
  return { group, ranking, topTracks: ranking.slice(0, 50) };
}

export const GET: APIRoute = async () => {
  try {
    const { group, topTracks } = await rankingData();
    const sources = topTracks.length > 0 ? await resolveBurnAudioSources(topTracks) : new Map();
    const measuredTracks = topTracks.map((track) => ({ ...track, duration: sources.get(track.id)?.duration ?? track.duration }));
    const storedLayout = group.status.votingComplete ? await getDiscLayout() : undefined;
    const topIds = new Set(topTracks.map((track) => track.id));
    const layout = storedLayout?.topTrackIds.length === topIds.size && storedLayout.topTrackIds.every((id) => topIds.has(id))
      ? storedLayout
      : undefined;
    return Response.json({
      status: group.status,
      layout: layout ?? null,
      tracks: measuredTracks,
      organizerId: "viktor",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, 500);
  }
};

export const PUT: APIRoute = async ({ request }) => {
  if (!isSameOrigin(request)) return Response.json({ error: "Ongeldige opslagaanvraag." }, { status: 403 });
  try {
    const body = await request.json() as { memberId?: unknown; discs?: unknown };
    requireOrganizer(request, body.memberId);
    const { group, topTracks } = await rankingData();
    if (!group.status.votingComplete) throw new Error("De cd-indeling komt beschikbaar zodra iedereen klaar is met stemmen.");
    const topTrackIds = topTracks.map((track) => track.id);
    return Response.json({ layout: await saveDiscLayout(body.discs, topTrackIds) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!isSameOrigin(request)) return Response.json({ error: "Ongeldige aanvraag." }, { status: 403 });
  try {
    const body = await request.json().catch(() => ({})) as { memberId?: unknown };
    requireOrganizer(request, body.memberId);
    const { group, topTracks } = await rankingData();
    if (!group.status.votingComplete) throw new Error("De cd-indeling komt beschikbaar zodra iedereen klaar is met stemmen.");
    const layout = await getDiscLayout();
    if (!layout) throw new Error("Er is nog geen cd-indeling om definitief te maken.");
    const sources = await validateBurnCapacity(layout, topTracks);
    const tracksWithActualDuration = topTracks.map((track) => ({ ...track, duration: sources.get(track.id)?.duration ?? track.duration }));
    const finalized = await finalizeDiscLayout(tracksWithActualDuration, topTracks.map((track) => track.id));
    void ensureBurnPackages(finalized, topTracks);
    return Response.json(
      { layout: finalized },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
};
