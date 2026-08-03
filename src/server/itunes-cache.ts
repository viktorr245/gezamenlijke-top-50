import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Track } from "../data/tracks";

const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR ?? process.env.AUDIO_STORAGE_DIR ?? path.join(process.cwd(), "storage"));
const DEFAULT_CACHE_PATH = path.join(STORAGE_ROOT, "itunes-cache.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_LIMIT = 8;

type ITunesResult = Record<string, unknown> & {
  kind?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
  previewUrl?: string;
  trackViewUrl?: string;
};

type CachedRecord = {
  raw: ITunesResult;
  track: Track;
  updatedAt: string;
  pinnedAt?: string;
};

type CachedQuery = {
  query: string;
  fetchedAt: string;
  sourceIds: string[];
};

type ITunesCache = {
  version: 1;
  queries: Record<string, CachedQuery>;
  records: Record<string, CachedRecord>;
};

export type ITunesCacheStatus = "HIT" | "MISS" | "STALE";

export type ITunesSearch = {
  tracks: Track[];
  cacheStatus: ITunesCacheStatus;
};

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const writeQueues = new Map<string, Promise<void>>();
const searchesInFlight = new Map<string, Promise<ITunesSearch>>();

function emptyCache(): ITunesCache {
  return { version: 1, queries: {}, records: {} };
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("nl-NL");
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeResult(result: ITunesResult): Track | undefined {
  if (result.kind !== "song" || !Number.isFinite(result.trackId)) return undefined;
  const title = typeof result.trackName === "string" ? result.trackName.trim() : "";
  const artist = typeof result.artistName === "string" ? result.artistName.trim() : "";
  const artworkUrl = safeHttpsUrl(result.artworkUrl100);
  if (!title || !artist || !artworkUrl) return undefined;
  const sourceId = String(result.trackId);

  return {
    id: `itunes-${sourceId}`,
    title,
    artist,
    album: typeof result.collectionName === "string" ? result.collectionName.trim() || undefined : undefined,
    owner: "viktor",
    score: 0,
    duration: Math.max(0, Math.round((typeof result.trackTimeMillis === "number" ? result.trackTimeMillis : 0) / 1000)),
    cover: artworkUrl.replace(/\d+x\d+bb(?=\.(?:jpg|jpeg|png|webp))/i, "300x300bb"),
    tone: 220 + (Number(result.trackId) % 220),
    previewUrl: safeHttpsUrl(result.previewUrl),
    source: "itunes",
    sourceId,
    sourceUrl: safeHttpsUrl(result.trackViewUrl),
  };
}

function isTrack(value: unknown): value is Track {
  if (!value || typeof value !== "object") return false;
  const track = value as Partial<Track>;
  return Boolean(
    typeof track.id === "string"
    && track.id.startsWith("itunes-")
    && typeof track.title === "string"
    && typeof track.artist === "string"
    && typeof track.duration === "number"
    && Number.isFinite(track.duration)
    && typeof track.cover === "string"
    && track.source === "itunes"
    && typeof track.sourceId === "string",
  );
}

function parseCache(value: unknown): ITunesCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyCache();
  const candidate = value as Partial<ITunesCache>;
  const records = Object.fromEntries(
    Object.entries(candidate.records ?? {}).filter((entry): entry is [string, CachedRecord] => {
      const [sourceId, record] = entry;
      return Boolean(
        /^\d+$/.test(sourceId)
        && record
        && typeof record === "object"
        && record.raw
        && typeof record.raw === "object"
        && !Array.isArray(record.raw)
        && isTrack(record.track)
        && record.track.sourceId === sourceId
        && typeof record.updatedAt === "string"
        && (record.pinnedAt === undefined || typeof record.pinnedAt === "string"),
      );
    }),
  );
  const queries = Object.fromEntries(
    Object.entries(candidate.queries ?? {}).filter((entry): entry is [string, CachedQuery] => {
      const [, query] = entry;
      return Boolean(
        query
        && typeof query === "object"
        && typeof query.query === "string"
        && typeof query.fetchedAt === "string"
        && Array.isArray(query.sourceIds)
        && query.sourceIds.every((sourceId) => typeof sourceId === "string" && records[sourceId]),
      );
    }),
  );
  return { version: 1, records, queries };
}

async function readCache(cachePath: string): Promise<ITunesCache> {
  try {
    return parseCache(JSON.parse(await readFile(cachePath, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCache();
    throw error;
  }
}

async function writeCache(cachePath: string, cache: ITunesCache) {
  const directory = path.dirname(cachePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.itunes-cache-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await rename(temporaryPath, cachePath);
}

function enqueue<T>(cachePath: string, operation: () => Promise<T>): Promise<T> {
  const queue = writeQueues.get(cachePath) ?? Promise.resolve();
  const result = queue.then(operation, operation);
  writeQueues.set(cachePath, result.then(() => undefined, () => undefined));
  return result;
}

function tracksForQuery(cache: ITunesCache, query: CachedQuery): Track[] {
  return query.sourceIds.map((sourceId) => cache.records[sourceId]?.track).filter(isTrack);
}

function isFresh(query: CachedQuery): boolean {
  const fetchedAt = Date.parse(query.fetchedAt);
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < CACHE_TTL_MS;
}

async function fetchITunes(query: string, fetcher: Fetcher): Promise<ITunesResult[]> {
  const params = new URLSearchParams({
    term: query,
    country: "NL",
    media: "music",
    entity: "song",
    limit: String(SEARCH_LIMIT),
  });
  const response = await fetcher(`https://itunes.apple.com/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("iTunes zoeken mislukt.");
  const payload = await response.json() as { results?: unknown };
  if (!Array.isArray(payload.results)) throw new Error("iTunes gaf een ongeldig antwoord.");
  return payload.results.filter((result): result is ITunesResult => Boolean(result && typeof result === "object" && !Array.isArray(result)));
}

export async function searchITunes(
  query: string,
  fetcher: Fetcher = fetch,
  cachePath = DEFAULT_CACHE_PATH,
): Promise<ITunesSearch> {
  const trimmed = query.trim().replace(/\s+/g, " ");
  const key = normalizeQuery(trimmed);
  if (key.length < 2 || key.length > 100) throw new Error("Gebruik twee tot honderd tekens om te zoeken.");

  const cache = await readCache(cachePath);
  const cachedQuery = cache.queries[key];
  if (cachedQuery && isFresh(cachedQuery)) return { tracks: tracksForQuery(cache, cachedQuery), cacheStatus: "HIT" };

  const inFlightKey = `${cachePath}\0${key}`;
  const existing = searchesInFlight.get(inFlightKey);
  if (existing) return existing;

  const search: Promise<ITunesSearch> = (async () => {
    try {
      const rawResults = await fetchITunes(trimmed, fetcher);
      return await enqueue(cachePath, async () => {
        const latest = await readCache(cachePath);
        const now = new Date().toISOString();
        const sourceIds: string[] = [];
        for (const raw of rawResults) {
          const track = normalizeResult(raw);
          if (!track?.sourceId || sourceIds.includes(track.sourceId)) continue;
          const previous = latest.records[track.sourceId];
          latest.records[track.sourceId] = {
            raw,
            track,
            updatedAt: now,
            ...(previous?.pinnedAt ? { pinnedAt: previous.pinnedAt } : {}),
          };
          sourceIds.push(track.sourceId);
        }
        latest.queries[key] = { query: trimmed, fetchedAt: now, sourceIds };
        await writeCache(cachePath, latest);
        return { tracks: sourceIds.map((sourceId) => latest.records[sourceId].track), cacheStatus: "MISS" };
      });
    } catch (error) {
      if (cachedQuery) return { tracks: tracksForQuery(cache, cachedQuery), cacheStatus: "STALE" };
      throw error;
    }
  })();

  searchesInFlight.set(inFlightKey, search);
  try {
    return await search;
  } finally {
    searchesInFlight.delete(inFlightKey);
  }
}

export async function pinITunesTrack(sourceId: string, cachePath = DEFAULT_CACHE_PATH): Promise<Track> {
  if (!/^\d+$/.test(sourceId)) throw new Error("Ongeldig iTunes-nummer.");
  return enqueue(cachePath, async () => {
    const cache = await readCache(cachePath);
    const record = cache.records[sourceId];
    if (!record) throw new Error("Dit nummer staat niet meer in de zoekcache. Zoek het opnieuw op.");
    record.pinnedAt ??= new Date().toISOString();
    await writeCache(cachePath, cache);
    return record.track;
  });
}

export async function listPinnedITunesTracks(cachePath = DEFAULT_CACHE_PATH): Promise<Track[]> {
  const cache = await readCache(cachePath);
  return Object.values(cache.records)
    .filter((record) => Boolean(record.pinnedAt))
    .sort((a, b) => String(a.pinnedAt).localeCompare(String(b.pinnedAt)))
    .map((record) => record.track);
}
