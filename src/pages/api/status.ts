import type { APIRoute } from "astro";
import { loadGroupData } from "../../server/group-state";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    const { status } = await loadGroupData();
    return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "De groepsstatus kon niet worden geladen." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};
