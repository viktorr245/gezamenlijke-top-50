import type { APIRoute } from "astro";
import { loadGroupData } from "../../server/group-state";
import { calculateRanking } from "../../server/ranking";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    const group = await loadGroupData();
    if (!group.status.votingComplete) {
      return Response.json({ status: group.status, ranking: null }, { headers: { "Cache-Control": "no-store" } });
    }
    const choices = Object.values(group.voteChoices).flat();
    const ranking = calculateRanking(group.tracks, choices);
    return Response.json({ status: group.status, ranking }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "De ranglijst kon niet worden berekend." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};
