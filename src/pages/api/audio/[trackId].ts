import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { APIRoute } from "astro";
import { getAudioAsset, removeAudio, saveAudio, validateTrackId } from "../../../server/audio-storage";
import { AuthorizationError, requireMember } from "../../../server/auth";
import { isSameOrigin } from "../../../server/request-security";
import { getSubmission, saveDraftSubmission } from "../../../server/submission-storage";
import { withSubmissionAudioLock } from "../../../server/submission-audio-lock";

export const prerender = false;

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function requestedRange(header: string | null, size: number): { start: number; end: number } | undefined | null {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

export const GET: APIRoute = async ({ params, request }) => {
  try {
    const trackId = validateTrackId(params.trackId);
    const wantsOriginal = new URL(request.url).searchParams.get("original") === "1";
    const asset = await getAudioAsset(trackId, wantsOriginal);
    if (!asset) return errorResponse("Voor dit nummer is nog geen audiobestand toegevoegd.", 404);
    const range = requestedRange(request.headers.get("Range"), asset.size);
    if (range === null) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${asset.size}`, "Cache-Control": "no-store" },
      });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? asset.size - 1;
    const length = end - start + 1;
    const file = await open(asset.path, "r");
    const body = Readable.toWeb(file.createReadStream({ start, end, autoClose: true })) as unknown as BodyInit;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0, must-revalidate",
        "Content-Length": String(length),
        "Content-Type": asset.mimeType,
        "X-Content-Type-Options": "nosniff",
        ...(asset.downloadName ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.downloadName)}` } : {}),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${asset.size}` } : {}),
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return errorResponse("Het audiobestand bestaat niet meer.", 404);
    if (error instanceof Error && error.message === "Ongeldig nummer-id.") return errorResponse(error.message, 400);
    return errorResponse("Het audiobestand kon niet worden geladen.", 500);
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  if (!isSameOrigin(request)) return errorResponse("Ongeldige uploadaanvraag.", 403);
  try {
    const trackId = validateTrackId(params.trackId);
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) return errorResponse("Kies eerst een audiobestand.", 400);
    const memberId = requireMember(request, form.get("memberId"));
    const audio = await withSubmissionAudioLock(async () => {
      const submission = await getSubmission(memberId);
      const track = submission?.tracks.find((candidate) => candidate.id === trackId);
      if (!submission || !track) throw new Error("Dit nummer staat niet in jouw inzending.");
      if (submission.finalizedAt) throw new Error("Audio van een definitieve inzending kan niet meer worden vervangen.");
      const audio = await saveAudio(trackId, file, {
        title: track.title,
        artist: track.artist,
      });
      const measuredDuration = audio.duration ? Math.max(1, Math.round(audio.duration)) : track.duration;
      if (measuredDuration !== track.duration) {
        await saveDraftSubmission(memberId, submission.tracks.map((candidate) => (
          candidate.id === trackId ? { ...candidate, duration: measuredDuration } : candidate
        )));
      }
      return audio;
    });
    return Response.json({ audio }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Uploaden is mislukt.";
    return errorResponse(message, error instanceof AuthorizationError ? error.status : message.includes("100 MB") ? 413 : message.includes("opslaglimiet") || message.includes("schijfruimte") ? 507 : message.includes("definitieve inzending") ? 409 : message.includes("jouw inzending") ? 403 : message.includes("duurde te lang") ? 504 : message.includes("FFmpeg") || message.includes("FFprobe") ? 500 : 400);
  }
};

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!isSameOrigin(request)) return errorResponse("Ongeldige verwijderaanvraag.", 403);
  try {
    const trackId = validateTrackId(params.trackId);
    const memberId = requireMember(request, new URL(request.url).searchParams.get("memberId"));
    const removed = await withSubmissionAudioLock(async () => {
      const submission = await getSubmission(memberId);
      if (!submission?.tracks.some((track) => track.id === trackId)) throw new Error("Dit nummer staat niet in jouw inzending.");
      if (submission.finalizedAt) throw new Error("Audio van een definitieve inzending kan niet worden verwijderd.");
      return removeAudio(trackId);
    });
    return removed ? new Response(null, { status: 204 }) : errorResponse("Er is geen audiobestand om te verwijderen.", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Verwijderen is mislukt.";
    return errorResponse(message, error instanceof AuthorizationError ? error.status : message.includes("definitieve inzending") ? 409 : message.includes("jouw inzending") ? 403 : 400);
  }
};
