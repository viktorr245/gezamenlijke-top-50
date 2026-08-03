import type { APIRoute } from "astro";
import { getITunesPreviewUrl } from "../../../../server/itunes-cache";

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
  try {
    const sourceUrl = await getITunesPreviewUrl(params.sourceId ?? "");
    const range = request.headers.get("Range");
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: "audio/*",
        ...(range ? { Range: range } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !response.body) throw new Error("iTunes-preview ophalen mislukt.");
    const type = response.headers.get("Content-Type");
    if (!type?.toLowerCase().startsWith("audio/")) throw new Error("iTunes gaf geen audio terug.");
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        ...(response.headers.get("Content-Length") ? { "Content-Length": response.headers.get("Content-Length")! } : {}),
        ...(response.headers.get("Content-Range") ? { "Content-Range": response.headers.get("Content-Range")! } : {}),
        ...(response.headers.get("Accept-Ranges") ? { "Accept-Ranges": response.headers.get("Accept-Ranges")! } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "De iTunes-preview kon niet worden geladen.";
    return Response.json(
      { error: message },
      { status: message.includes("Ongeldig") ? 400 : message.includes("geen iTunes-preview") ? 404 : 502, headers: { "Cache-Control": "no-store" } },
    );
  }
};
