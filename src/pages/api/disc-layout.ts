import type { APIRoute } from "astro";
import { distributeRankedTracks } from "../../data/disc-distribution";
import { AuthorizationError, requireOrganizer } from "../../server/auth";
import { ensureBurnPackages, resolveBurnAudioSources, validateBurnCapacity } from "../../server/burn-packages";
import { finalizeDiscLayout, getDiscLayout, saveDiscLayout } from "../../server/disc-layout-storage";
import { loadGroupData } from "../../server/group-state";
import { calculateFinalRanking } from "../../server/ranking";
import { isSameOrigin } from "../../server/request-security";

export const prerender = false;

function errorResponse(error: unknown, fallbackStatus = 400) {
  const message = error instanceof Error ? error.message : "De cd-indeling kon niet worden opgeslagen.";
  return Response.json({ error: message }, { status: error instanceof AuthorizationError ? error.status : message.includes("al definitief") ? 409 : message.includes("schijfruimte") || message.includes("opslaglimiet") ? 507 : fallbackStatus, headers: { "Cache-Control": "no-store" } });
}

async function rankingData() {
  const group = await loadGroupData();
  if (!group.status.votingComplete) return { group, ranking: null, topTracks: [] };
  const ranking = calculateFinalRanking(group.tracks, Object.values(group.voteChoices).flat());
  return { group, ranking, topTracks: ranking.slice(0, 50) };
}

function sameDiscs(left: unknown, right: string[][]): boolean {
  return Array.isArray(left) && left.every((disc) => Array.isArray(disc))
    && left.length === right.length
    && left.every((disc: unknown[], discIndex) => disc.length === right[discIndex]?.length
      && disc.every((id, trackIndex) => id === right[discIndex][trackIndex]));
}

export const GET: APIRoute = async () => {
  try {
    const { group, topTracks } = await rankingData();
    const sources = topTracks.length > 0 ? await resolveBurnAudioSources(topTracks) : new Map();
    const measuredTracks = topTracks.map((track) => ({ ...track, duration: sources.get(track.id)?.duration ?? track.duration }));
    const expectedDiscs = measuredTracks.length === 50 ? distributeRankedTracks(measuredTracks) : [[], [], []];
    const storedLayout = group.status.votingComplete ? await getDiscLayout() : undefined;
    const topIds = topTracks.map((track) => track.id);
    const layout = storedLayout?.topTrackIds.length === topIds.length
      && storedLayout.topTrackIds.every((id, index) => id === topIds[index])
      && sameDiscs(storedLayout.discs, expectedDiscs)
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
    const sources = await resolveBurnAudioSources(topTracks);
    const measuredTracks = topTracks.map((track) => ({ ...track, duration: sources.get(track.id)?.duration ?? track.duration }));
    const expectedDiscs = distributeRankedTracks(measuredTracks);
    if (!sameDiscs(body.discs, expectedDiscs)) {
      throw new Error("De cd-grenzen moeten automatisch uit de werkelijke audiolengtes worden berekend.");
    }
    return Response.json({ layout: await saveDiscLayout(expectedDiscs, topTrackIds) }, { headers: { "Cache-Control": "no-store" } });
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
    if (!sameDiscs(layout.discs, distributeRankedTracks(tracksWithActualDuration))) {
      throw new Error("De cd-grenzen komen niet overeen met de automatische verdeling.");
    }
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
