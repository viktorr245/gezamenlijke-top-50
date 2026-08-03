import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { APIRoute } from "astro";
import { ensureBurnPackages, getBurnPackageFile, loadFinalBurnContext } from "../../../server/burn-packages";

export const prerender = false;

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

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("nog niet definitief") || message.includes("nog niet vast") || message.includes("hoort niet meer")) return 409;
  return 500;
}

export const GET: APIRoute = async ({ params, request }) => {
  try {
    const { layout, tracks } = await loadFinalBurnContext();
    const status = await ensureBurnPackages(layout, tracks);
    if (status.state !== "ready") {
      return Response.json(
        { error: status.state === "error" ? status.error : "Het brandpakket wordt nog gemaakt." },
        { status: status.state === "error" ? 500 : 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    const file = await getBurnPackageFile(layout, params.packageId ?? "");
    if (!file) return Response.json({ error: "Onbekend brandpakket." }, { status: 404 });
    const range = requestedRange(request.headers.get("Range"), file.size);
    if (range === null) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}`, "Cache-Control": "no-store" } });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    const length = end - start + 1;
    const body = Readable.toWeb(createReadStream(file.path, { start, end })) as unknown as BodyInit;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0, must-revalidate",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Content-Length": String(length),
        "Content-Type": "application/zip",
        "X-Content-Type-Options": "nosniff",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.size}` } : {}),
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Het brandpakket kon niet worden gedownload." },
      { status: errorStatus(error), headers: { "Cache-Control": "no-store" } },
    );
  }
};
