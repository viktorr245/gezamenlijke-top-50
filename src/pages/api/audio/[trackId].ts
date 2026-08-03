import { open } from "node:fs/promises";
import type { APIRoute } from "astro";
import { getAudioAsset, removeAudio, saveAudio, validateTrackId } from "../../../server/audio-storage";
import { getSubmission } from "../../../server/submission-storage";

export const prerender = false;

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
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
    try {
      const body = new Uint8Array(length);
      await file.read(body, 0, length, start);
      return new Response(body, {
        status: range ? 206 : 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=0, must-revalidate",
          "Content-Length": String(length),
          "Content-Type": asset.mimeType,
          ...(asset.downloadName ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.downloadName)}` } : {}),
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${asset.size}` } : {}),
        },
      });
    } finally {
      await file.close();
    }
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Het audiobestand kon niet worden geladen.", 400);
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return errorResponse("Ongeldige uploadaanvraag.", 403);
  try {
    const trackId = validateTrackId(params.trackId);
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) return errorResponse("Kies eerst een audiobestand.", 400);
    const memberId = String(form.get("memberId") ?? "");
    const submission = await getSubmission(memberId);
    if (!submission?.tracks.some((track) => track.id === trackId)) return errorResponse("Dit nummer staat niet in jouw inzending.", 403);
    const audio = await saveAudio(trackId, file, {
      title: String(form.get("title") ?? ""),
      artist: String(form.get("artist") ?? ""),
    });
    return Response.json({ audio }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Uploaden is mislukt.";
    return errorResponse(message, message.includes("100 MB") ? 413 : message.includes("FFmpeg") ? 500 : 400);
  }
};

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return errorResponse("Ongeldige verwijderaanvraag.", 403);
  try {
    const trackId = validateTrackId(params.trackId);
    const memberId = new URL(request.url).searchParams.get("memberId") ?? "";
    const submission = await getSubmission(memberId);
    if (!submission?.tracks.some((track) => track.id === trackId)) return errorResponse("Dit nummer staat niet in jouw inzending.", 403);
    if (submission.finalizedAt) return errorResponse("Audio van een definitieve inzending kan niet worden verwijderd.", 409);
    const removed = await removeAudio(trackId);
    return removed ? new Response(null, { status: 204 }) : errorResponse("Er is geen audiobestand om te verwijderen.", 404);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Verwijderen is mislukt.", 400);
  }
};
