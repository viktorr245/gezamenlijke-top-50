import type { APIRoute } from "astro";
import { loadGroupData } from "../../../server/group-state";
import { buildTrackHistory } from "../../../server/ranking-history";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  try {
    const group = await loadGroupData();
    if (!group.status.votingComplete) {
      return Response.json(
        { error: "De keuzegeschiedenis is beschikbaar zodra iedereen klaar is." },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    const trackId = params.trackId ?? "";
    const history = buildTrackHistory(group.tracks, Object.values(group.voteChoices).flat(), trackId);
    if (!history) {
      return Response.json(
        { error: "Dit nummer staat niet in de ranglijst." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json({ history }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Keuzegeschiedenis laden mislukt:", error);
    return Response.json(
      { error: "De keuzegeschiedenis kon niet worden geladen." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};
