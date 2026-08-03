import type { APIRoute } from "astro";
import { isMemberId } from "../../../data/tracks";
import { loadGroupData } from "../../../server/group-state";
import { buildComparisonSchedules, castVote, undoLastVote } from "../../../server/vote-storage";

export const prerender = false;

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

async function votingPayload(memberIdValue: string) {
  if (!isMemberId(memberIdValue)) throw new Error("Onbekende deelnemer.");
  const group = await loadGroupData();
  const memberStatus = group.status.members.find((status) => status.memberId === memberIdValue)!;
  if (!group.status.readyForVoting) {
    return { status: group.status, member: memberStatus, comparison: null, tracks: null, canUndo: false };
  }
  const schedule = buildComparisonSchedules(group.submissions)[memberIdValue];
  const choices = group.voteChoices[memberIdValue] ?? [];
  const comparison = schedule[choices.length] ?? null;
  const tracksById = new Map(group.tracks.map((track) => [track.id, track]));
  return {
    status: group.status,
    member: memberStatus,
    comparison,
    tracks: comparison ? {
      left: tracksById.get(comparison.leftId),
      right: tracksById.get(comparison.rightId),
    } : null,
    canUndo: choices.length > 0 && !group.status.votingComplete,
  };
}

export const GET: APIRoute = async ({ params }) => {
  try {
    return Response.json(await votingPayload(params.memberId ?? ""), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Stemmen laden mislukt." }, { status: 400 });
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return Response.json({ error: "Ongeldige stemaanvraag." }, { status: 403 });
  try {
    const memberId = params.memberId ?? "";
    const group = await loadGroupData();
    if (!group.status.readyForVoting) throw new Error("Stemmen begint zodra alle vijf inzendingen en audiobestanden compleet zijn.");
    const body = await request.json() as { comparisonId?: unknown; winnerId?: unknown };
    if (typeof body.comparisonId !== "string" || typeof body.winnerId !== "string") throw new Error("Ongeldige keuze.");
    await castVote(group.submissions, memberId, body.comparisonId, body.winnerId);
    return Response.json(await votingPayload(memberId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Je keuze kon niet worden opgeslagen.";
    return Response.json({ error: message }, { status: message.includes("niet meer actueel") ? 409 : 400 });
  }
};

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return Response.json({ error: "Ongeldige stemaanvraag." }, { status: 403 });
  try {
    const memberId = params.memberId ?? "";
    const group = await loadGroupData();
    if (!group.status.readyForVoting) throw new Error("Er zijn nog geen stemmen om terug te draaien.");
    await undoLastVote(group.submissions, memberId);
    return Response.json(await votingPayload(memberId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "De laatste keuze kon niet worden teruggedraaid." }, { status: 400 });
  }
};
