import type { APIRoute } from "astro";
import { listAudioRecords, removeAudioBatch } from "../../../server/audio-storage";
import { AuthorizationError, requireMember } from "../../../server/auth";
import { isSameOrigin } from "../../../server/request-security";
import { finalizeSubmission, getSubmission, saveDraftSubmission } from "../../../server/submission-storage";
import { withSubmissionAudioLock } from "../../../server/submission-audio-lock";

export const prerender = false;

function errorStatus(error: unknown): number {
  if (error instanceof AuthorizationError) return error.status;
  const message = error instanceof Error ? error.message : "";
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOSPC" || code === "EDQUOT" || message.includes("opslaglimiet") || message.includes("schijfruimte")) return 507;
  if (message.includes("al definitief") || message.includes("Voeg eerst audio")) return 409;
  if ([
    "maximaal twintig", "ongeldige gegevens", "maar één keer", "al in de lijst",
    "nummer-id", "precies twintig",
  ].some((part) => message.includes(part))) return 400;
  return 500;
}

function invalidJsonResponse() {
  return Response.json({ error: "De aanvraag bevat geen geldige JSON." }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

export const GET: APIRoute = async ({ params, request }) => {
  try {
    const memberId = requireMember(request, params.memberId);
    const submission = await getSubmission(memberId);
    return Response.json({ submission: submission ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "De inzending kon niet worden geladen." },
      { status: error instanceof AuthorizationError ? error.status : 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};

export const PUT: APIRoute = async ({ params, request }) => {
  if (!isSameOrigin(request)) return Response.json({ error: "Ongeldige inzendingsaanvraag." }, { status: 403 });
  let body: { tracks?: unknown };
  try {
    body = await request.json() as { tracks?: unknown };
  } catch {
    return invalidJsonResponse();
  }
  try {
    const memberId = requireMember(request, params.memberId);
    const submission = await withSubmissionAudioLock(async () => {
      const previous = await getSubmission(memberId);
      const saved = await saveDraftSubmission(memberId, Array.isArray(body.tracks) ? body.tracks : []);
      const retainedIds = new Set(saved.tracks.map((track) => track.id));
      const removedIds = (previous?.tracks ?? []).filter((track) => !retainedIds.has(track.id)).map((track) => track.id);
      try {
        await removeAudioBatch(removedIds);
      } catch (error) {
        if (previous) {
          try {
            await saveDraftSubmission(memberId, previous.tracks);
          } catch {
            console.error("De vorige inzending kon na een mislukte audio-update niet worden hersteld.");
          }
        }
        throw error;
      }
      return saved;
    });
    return Response.json({ submission }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "De inzending kon niet worden opgeslagen.";
    return Response.json({ error: message }, { status: errorStatus(error), headers: { "Cache-Control": "no-store" } });
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  if (!isSameOrigin(request)) return Response.json({ error: "Ongeldige inzendingsaanvraag." }, { status: 403 });
  let body: { tracks?: unknown };
  try {
    body = await request.json() as { tracks?: unknown };
  } catch {
    return invalidJsonResponse();
  }
  try {
    const memberId = requireMember(request, params.memberId);
    const tracks = Array.isArray(body.tracks) ? body.tracks : [];
    const submission = await withSubmissionAudioLock(async () => {
      const audio = await listAudioRecords();
      const missingAudio = tracks
        .filter((track): track is { id: string } => Boolean(track && typeof track === "object" && typeof (track as { id?: unknown }).id === "string"))
        .filter((track) => !audio[track.id]);
      if (missingAudio.length > 0) throw new Error(`Voeg eerst audio toe aan alle twintig nummers. Er ontbreken er nog ${missingAudio.length}.`);
      return finalizeSubmission(memberId, tracks);
    });
    return Response.json({ submission }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "De inzending kon niet definitief worden gemaakt.";
    return Response.json(
      { error: message },
      { status: errorStatus(error), headers: { "Cache-Control": "no-store" } },
    );
  }
};
