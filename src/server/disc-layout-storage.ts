import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Track } from "../data/tracks";

const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR ?? process.env.AUDIO_STORAGE_DIR ?? path.join(process.cwd(), "storage"));
const DEFAULT_STORAGE_PATH = path.join(STORAGE_ROOT, "disc-layout.json");
const TRACK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

export type DiscLayout = {
  discs: string[][];
  topTrackIds: string[];
  updatedAt: string;
  finalizedAt: string | null;
};

const writeQueues = new Map<string, Promise<void>>();

function safeIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !TRACK_ID_PATTERN.test(id))) return undefined;
  return [...value];
}

function validateLayoutParts(discsValue: unknown, topTrackIdsValue: unknown): { discs: string[][]; topTrackIds: string[] } {
  if (!Array.isArray(discsValue) || discsValue.length !== 3) throw new Error("De indeling moet precies drie cd’s bevatten.");
  const discs = discsValue.map(safeIds);
  const topTrackIds = safeIds(topTrackIdsValue);
  if (discs.some((disc) => !disc) || !topTrackIds || topTrackIds.length !== 50) {
    throw new Error("De cd-indeling moet alle vijftig nummers bevatten.");
  }
  const flattened = (discs as string[][]).flat();
  if (flattened.length !== 50 || new Set(flattened).size !== 50 || new Set(topTrackIds).size !== 50) {
    throw new Error("Ieder nummer moet precies één keer in de cd-indeling staan.");
  }
  const expected = new Set(topTrackIds);
  if (flattened.some((id) => !expected.has(id))) throw new Error("De cd-indeling komt niet overeen met de top 50.");
  return { discs: discs as string[][], topTrackIds };
}

function safeLayout(value: unknown): DiscLayout | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<DiscLayout>;
  try {
    const parts = validateLayoutParts(candidate.discs, candidate.topTrackIds);
    if (typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt))) return undefined;
    if (candidate.finalizedAt !== null && (typeof candidate.finalizedAt !== "string" || !Number.isFinite(Date.parse(candidate.finalizedAt)))) return undefined;
    return { ...parts, updatedAt: candidate.updatedAt, finalizedAt: candidate.finalizedAt };
  } catch {
    return undefined;
  }
}

async function readLayout(storagePath: string): Promise<DiscLayout | undefined> {
  try {
    return safeLayout(JSON.parse(await readFile(storagePath, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeLayout(storagePath: string, layout: DiscLayout) {
  const directory = path.dirname(storagePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.disc-layout-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(layout, null, 2)}\n`, "utf8");
  await rename(temporaryPath, storagePath);
}

function enqueue<T>(storagePath: string, operation: () => Promise<T>): Promise<T> {
  const queue = writeQueues.get(storagePath) ?? Promise.resolve();
  const result = queue.then(operation, operation);
  writeQueues.set(storagePath, result.then(() => undefined, () => undefined));
  return result;
}

export async function getDiscLayout(storagePath = DEFAULT_STORAGE_PATH): Promise<DiscLayout | undefined> {
  return readLayout(storagePath);
}

export async function saveDiscLayout(
  discsValue: unknown,
  topTrackIdsValue: unknown,
  storagePath = DEFAULT_STORAGE_PATH,
): Promise<DiscLayout> {
  const parts = validateLayoutParts(discsValue, topTrackIdsValue);
  return enqueue(storagePath, async () => {
    const existing = await readLayout(storagePath);
    const sameRanking = existing
      && existing.topTrackIds.length === parts.topTrackIds.length
      && existing.topTrackIds.every((id) => parts.topTrackIds.includes(id));
    if (existing?.finalizedAt && sameRanking) throw new Error("De cd-indeling is al definitief en kan niet meer worden gewijzigd.");
    const layout: DiscLayout = { ...parts, updatedAt: new Date().toISOString(), finalizedAt: null };
    await writeLayout(storagePath, layout);
    return layout;
  });
}

export async function finalizeDiscLayout(
  tracks: Track[],
  expectedTopTrackIds: string[],
  storagePath = DEFAULT_STORAGE_PATH,
): Promise<DiscLayout> {
  if (tracks.length !== 50 || expectedTopTrackIds.length !== 50) {
    throw new Error("De cd-indeling kan alleen met de volledige top 50 definitief worden gemaakt.");
  }
  return enqueue(storagePath, async () => {
    const layout = await readLayout(storagePath);
    if (!layout) throw new Error("Er is nog geen cd-indeling om definitief te maken.");
    if (layout.finalizedAt) return layout;
    const tracksById = new Map(tracks.map((track) => [track.id, track]));
    const expected = new Set(expectedTopTrackIds.length > 0 ? expectedTopTrackIds : layout.topTrackIds);
    if (expected.size !== 50 || layout.topTrackIds.some((id) => !expected.has(id))) throw new Error("De ranglijst en cd-indeling komen niet meer overeen.");
    const hasUnknownTrack = layout.discs.flat().some((id) => !tracksById.has(id));
    const overCapacity = layout.discs.some((disc) => (
      disc.reduce((total, id) => total + (tracksById.get(id)?.duration ?? 0), 0) + Math.max(0, disc.length - 1) * 2 > 4800
    ));
    if (hasUnknownTrack) throw new Error("De cd-indeling bevat een onbekend nummer.");
    if (overCapacity) throw new Error("Minstens één cd is langer dan 80 minuten.");
    const finalized = { ...layout, updatedAt: new Date().toISOString(), finalizedAt: new Date().toISOString() };
    await writeLayout(storagePath, finalized);
    return finalized;
  });
}
