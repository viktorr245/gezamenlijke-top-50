import type { APIRoute } from "astro";
import { searchITunes } from "../../../server/itunes-cache";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const result = await searchITunes(query);
    return Response.json(
      { tracks: result.tracks },
      {
        headers: {
          "Cache-Control": "public, max-age=900, stale-while-revalidate=86400",
          "X-iTunes-Cache": result.cacheStatus,
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "iTunes zoeken mislukt.";
    return Response.json(
      { error: message },
      { status: message.startsWith("Gebruik twee") ? 400 : 502, headers: { "Cache-Control": "no-store" } },
    );
  }
};
