import type { APIRoute } from "astro";
import { listAudioRecords } from "../../../server/audio-storage";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    const audio = await listAudioRecords();
    return Response.json({ audio }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "De audiobestanden konden niet worden geladen." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};
