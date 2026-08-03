import type { APIRoute } from "astro";
import { listAudioRecords, removeAudio } from "../../../server/audio-storage";
import { finalizeSubmission, getSubmission, saveDraftSubmission } from "../../../server/submission-storage";
import { withSubmissionAudioLock } from "../../../server/submission-audio-lock";

export const prerender = false;

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

export const GET: APIRoute = async ({ params }) => {
  try {
    const submission = await getSubmission(params.memberId ?? "");
    return Response.json({ submission: submission ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "De inzending kon niet worden geladen." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
};

export const PUT: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return Response.json({ error: "Ongeldige inzendingsaanvraag." }, { status: 403 });
  try {
    const body = await request.json() as { tracks?: unknown };
    const memberId = params.memberId ?? "";
    const submission = await withSubmissionAudioLock(async () => {
      const previous = await getSubmission(memberId);
      const saved = await saveDraftSubmission(memberId, Array.isArray(body.tracks) ? body.tracks : []);
      const retainedIds = new Set(saved.tracks.map((track) => track.id));
      for (const track of previous?.tracks ?? []) {
        if (!retainedIds.has(track.id)) await removeAudio(track.id);
      }
      return saved;
    });
    return Response.json({ submission }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "De inzending kon niet worden opgeslagen.";
    return Response.json({ error: message }, { status: message.includes("al definitief") ? 409 : 400, headers: { "Cache-Control": "no-store" } });
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return Response.json({ error: "Ongeldige inzendingsaanvraag." }, { status: 403 });
  try {
    const body = await request.json() as { tracks?: unknown };
    const tracks = Array.isArray(body.tracks) ? body.tracks : [];
    const submission = await withSubmissionAudioLock(async () => {
      const audio = await listAudioRecords();
      const missingAudio = tracks
        .filter((track): track is { id: string } => Boolean(track && typeof track === "object" && typeof (track as { id?: unknown }).id === "string"))
        .filter((track) => !audio[track.id]);
      if (missingAudio.length > 0) throw new Error(`Voeg eerst audio toe aan alle twintig nummers. Er ontbreken er nog ${missingAudio.length}.`);
      return finalizeSubmission(params.memberId ?? "", tracks);
    });
    return Response.json({ submission }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "De inzending kon niet definitief worden gemaakt.";
    return Response.json(
      { error: message },
      { status: message.includes("al definitief") ? 409 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }
};
