import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMemberId, members, type MemberId, type Track } from "../data/tracks";

const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR ?? process.env.AUDIO_STORAGE_DIR ?? path.join(process.cwd(), "storage"));
const DEFAULT_STORAGE_PATH = path.join(STORAGE_ROOT, "submissions.json");
const LEGACY_MEMBER_IDS: Record<string, MemberId> = {
  viktor: "viktor",
  daniel: "daniel",
  keano: "keano",
  sander: "sander",
  jurjan: "jurjan",
  mila: "daniel",
  sam: "keano",
  jules: "sander",
  lena: "jurjan",
};

export type Submission = {
  memberId: MemberId;
  tracks: Track[];
  updatedAt: string;
  finalizedAt: string | null;
};

export type SubmissionIndex = Record<MemberId, Submission>;

type SubmissionDocument = {
  version: 2;
  submissions: Partial<SubmissionIndex>;
};

const writeQueues = new Map<string, Promise<void>>();

function validateMemberId(memberId: string): MemberId {
  if (!isMemberId(memberId)) throw new Error("Onbekende deelnemer.");
  return memberId;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed || undefined;
}

function safeUrl(value: unknown, allowLocalCover = false): string | undefined {
  const text = optionalString(value, 1000);
  if (!text) return undefined;
  if (allowLocalCover && /^\/covers\/[a-zA-Z0-9._-]+$/.test(text)) return text;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function safeTrack(value: unknown, owner: MemberId): Track | undefined {
  if (!value || typeof value !== "object") return undefined;
  const track = value as Partial<Track>;
  const id = optionalString(track.id, 100);
  const title = optionalString(track.title, 200);
  const artist = optionalString(track.artist, 200);
  const cover = safeUrl(track.cover, true);
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || !title || !artist || !cover || !Number.isFinite(track.duration)) return undefined;
  if (track.source === "itunes" && (
    typeof track.sourceId !== "string"
    || !/^\d+$/.test(track.sourceId)
    || id !== `itunes-${track.sourceId}`
  )) return undefined;
  if (track.source === "manual" && !id.startsWith(`manual-${owner}-`)) return undefined;
  if (track.source && track.source !== "itunes" && track.source !== "manual") return undefined;

  return {
    id,
    title,
    artist,
    album: optionalString(track.album, 300),
    owner,
    score: Number.isFinite(track.score) ? Number(track.score) : 0,
    duration: Math.max(0, Math.round(Number(track.duration))),
    cover,
    tone: Number.isFinite(track.tone) ? Number(track.tone) : 330,
    previewUrl: safeUrl(track.previewUrl),
    source: track.source === "itunes" || track.source === "manual" ? track.source : undefined,
    sourceId: track.source === "itunes" ? track.sourceId : undefined,
    sourceUrl: safeUrl(track.sourceUrl),
  };
}

function safeSubmission(value: unknown, memberId: MemberId): Submission | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<Submission>;
  if (!Array.isArray(candidate.tracks) || candidate.tracks.length > 20) return undefined;
  const tracks = candidate.tracks.map((track) => safeTrack(track, memberId));
  if (tracks.some((track) => !track) || new Set(tracks.map((track) => track!.id)).size !== tracks.length) return undefined;
  const updatedAt = typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt))
    ? candidate.updatedAt
    : typeof candidate.finalizedAt === "string" && Number.isFinite(Date.parse(candidate.finalizedAt))
      ? candidate.finalizedAt
      : new Date(0).toISOString();
  const finalizedAt = typeof candidate.finalizedAt === "string" && Number.isFinite(Date.parse(candidate.finalizedAt))
    ? candidate.finalizedAt
    : null;
  if (finalizedAt && tracks.length !== 20) return undefined;
  return { memberId, tracks: tracks as Track[], updatedAt, finalizedAt };
}

function emptyDocument(): SubmissionDocument {
  return { version: 2, submissions: {} };
}

async function readDocument(storagePath: string): Promise<SubmissionDocument> {
  try {
    const parsed = JSON.parse(await readFile(storagePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyDocument();
    const source = (parsed as Partial<SubmissionDocument>).version === 2
      ? (parsed as Partial<SubmissionDocument>).submissions
      : parsed as Record<string, unknown>;
    if (!source || typeof source !== "object" || Array.isArray(source)) return emptyDocument();
    const submissions: Partial<SubmissionIndex> = {};
    for (const [rawId, value] of Object.entries(source)) {
      const memberId = LEGACY_MEMBER_IDS[rawId];
      if (!memberId) continue;
      const submission = safeSubmission(value, memberId);
      if (submission) submissions[memberId] = submission;
    }
    return { version: 2, submissions };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
    throw error;
  }
}

async function writeDocument(storagePath: string, document: SubmissionDocument) {
  const directory = path.dirname(storagePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.submissions-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await rename(temporaryPath, storagePath);
}

function enqueue<T>(storagePath: string, operation: () => Promise<T>): Promise<T> {
  const queue = writeQueues.get(storagePath) ?? Promise.resolve();
  const result = queue.then(operation, operation);
  writeQueues.set(storagePath, result.then(() => undefined, () => undefined));
  return result;
}

function duplicateKey(track: Track): string {
  return track.source === "itunes" && track.sourceId
    ? `itunes:${track.sourceId}`
    : `${track.artist}\u0000${track.title}`.normalize("NFKD").toLocaleLowerCase("nl-NL").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function validateTracks(values: unknown[], memberId: MemberId): Track[] {
  if (values.length > 20) throw new Error("Je kunt maximaal twintig nummers toevoegen.");
  const tracks = values.map((track) => safeTrack(track, memberId));
  if (tracks.some((track) => !track)) throw new Error("Een of meer nummers bevatten ongeldige gegevens.");
  const valid = tracks as Track[];
  if (new Set(valid.map((track) => track.id)).size !== valid.length || new Set(valid.map(duplicateKey)).size !== valid.length) {
    throw new Error("Ieder nummer mag maar één keer voorkomen.");
  }
  return valid;
}

function assertNoGroupDuplicates(document: SubmissionDocument, memberId: MemberId, tracks: Track[]) {
  const claimed = new Map<string, MemberId>();
  const claimedIds = new Set<string>();
  for (const member of members) {
    if (member.id === memberId) continue;
    for (const track of document.submissions[member.id]?.tracks ?? []) {
      claimed.set(duplicateKey(track), member.id);
      claimedIds.add(track.id);
    }
  }
  const duplicate = tracks.find((track) => claimed.has(duplicateKey(track)));
  if (duplicate) throw new Error(`${duplicate.title} staat al in de lijst van iemand anders.`);
  if (tracks.some((track) => claimedIds.has(track.id))) throw new Error("Een nummer-id wordt al door iemand anders gebruikt.");
}

export async function listSubmissions(storagePath = DEFAULT_STORAGE_PATH): Promise<Partial<SubmissionIndex>> {
  return (await readDocument(storagePath)).submissions;
}

export async function getSubmission(memberIdValue: string, storagePath = DEFAULT_STORAGE_PATH): Promise<Submission | undefined> {
  const memberId = validateMemberId(memberIdValue);
  return (await readDocument(storagePath)).submissions[memberId];
}

export async function getFinalSubmission(memberId: string, storagePath = DEFAULT_STORAGE_PATH): Promise<Submission | undefined> {
  const submission = await getSubmission(memberId, storagePath);
  return submission?.finalizedAt ? submission : undefined;
}

export async function saveDraftSubmission(memberIdValue: string, values: unknown[], storagePath = DEFAULT_STORAGE_PATH): Promise<Submission> {
  const memberId = validateMemberId(memberIdValue);
  const tracks = validateTracks(values, memberId);
  return enqueue(storagePath, async () => {
    const document = await readDocument(storagePath);
    const existing = document.submissions[memberId];
    if (existing?.finalizedAt) throw new Error("Deze inzending is al definitief en kan niet meer worden gewijzigd.");
    assertNoGroupDuplicates(document, memberId, tracks);
    const submission: Submission = { memberId, tracks, updatedAt: new Date().toISOString(), finalizedAt: null };
    document.submissions[memberId] = submission;
    await writeDocument(storagePath, document);
    return submission;
  });
}

export async function finalizeSubmission(
  memberIdValue: string,
  values: unknown[],
  storagePath = DEFAULT_STORAGE_PATH,
): Promise<Submission> {
  const memberId = validateMemberId(memberIdValue);
  const tracks = validateTracks(values, memberId);
  if (tracks.length !== 20) throw new Error("Je inzending moet precies twintig nummers bevatten.");
  return enqueue(storagePath, async () => {
    const document = await readDocument(storagePath);
    const existing = document.submissions[memberId];
    if (existing?.finalizedAt) {
      if (existing.tracks.every((track, index) => track.id === tracks[index]?.id)) return existing;
      throw new Error("Deze inzending is al definitief en kan niet meer worden gewijzigd.");
    }
    assertNoGroupDuplicates(document, memberId, tracks);
    const now = new Date().toISOString();
    const submission: Submission = { memberId, tracks, updatedAt: now, finalizedAt: now };
    document.submissions[memberId] = submission;
    await writeDocument(storagePath, document);
    return submission;
  });
}

export async function resetSubmissionStorage(storagePath = DEFAULT_STORAGE_PATH): Promise<void> {
  await writeDocument(storagePath, emptyDocument());
}
