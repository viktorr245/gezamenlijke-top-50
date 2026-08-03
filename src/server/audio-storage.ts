import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertStorageCapacity, STORAGE_ROOT } from "./storage-health";

const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const AUDIO_DIRECTORY = path.join(STORAGE_ROOT, "audio");
const INDEX_PATH = path.join(STORAGE_ROOT, "audio-index.json");
const TRACK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH ?? "ffprobe";
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000;
const GENERATED_AUDIO_PATTERN = /^[a-zA-Z0-9_-]{1,100}-[a-f0-9]{32}(?:-o)?\.[a-z0-9]{2,5}$/;

const AUDIO_TYPES: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
};

type StoredAudioRecord = {
  trackId: string;
  title: string;
  artist: string;
  originalName: string;
  originalStoredName: string;
  originalMimeType: string;
  originalSize: number;
  playbackStoredName: string;
  playbackMimeType: "audio/webm";
  playbackSize: number;
  duration?: number;
  uploadedAt: string;
};

export type AudioRecord = Omit<StoredAudioRecord, "originalStoredName" | "playbackStoredName"> & {
  mimeType: string;
  size: number;
  url: string;
  originalUrl: string;
};

export type AudioAsset = {
  record: StoredAudioRecord;
  path: string;
  size: number;
  mimeType: string;
  downloadName?: string;
};

let writeQueue: Promise<void> = Promise.resolve();

function isStoredRecord(value: unknown): value is StoredAudioRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredAudioRecord>;
  const storedNamePattern = /^[a-zA-Z0-9_-]{1,180}\.[a-z0-9]{2,5}$/;
  return Boolean(
    typeof record.trackId === "string"
    && TRACK_ID_PATTERN.test(record.trackId)
    && typeof record.title === "string"
    && typeof record.artist === "string"
    && typeof record.originalName === "string"
    && typeof record.originalStoredName === "string"
    && storedNamePattern.test(record.originalStoredName)
    && typeof record.originalMimeType === "string"
    && typeof record.originalSize === "number"
    && Number.isFinite(record.originalSize)
    && typeof record.playbackStoredName === "string"
    && storedNamePattern.test(record.playbackStoredName)
    && record.playbackMimeType === "audio/webm"
    && typeof record.playbackSize === "number"
    && Number.isFinite(record.playbackSize)
    && (record.duration === undefined || (typeof record.duration === "number" && Number.isFinite(record.duration) && record.duration > 0))
    && typeof record.uploadedAt === "string",
  );
}

function publicRecord(record: StoredAudioRecord): AudioRecord {
  const { originalStoredName: _originalStoredName, playbackStoredName: _playbackStoredName, ...visible } = record;
  return {
    ...visible,
    mimeType: record.playbackMimeType,
    size: record.playbackSize,
    url: `/api/audio/${encodeURIComponent(record.trackId)}`,
    originalUrl: `/api/audio/${encodeURIComponent(record.trackId)}?original=1`,
  };
}

async function ensureStorage() {
  await mkdir(AUDIO_DIRECTORY, { recursive: true });
}

async function readIndex(): Promise<Record<string, StoredAudioRecord>> {
  try {
    const value = JSON.parse(await readFile(INDEX_PATH, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, StoredAudioRecord] => isStoredRecord(entry[1])));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeIndex(index: Record<string, StoredAudioRecord>) {
  await ensureStorage();
  const temporaryPath = path.join(STORAGE_ROOT, `.audio-index-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await rename(temporaryPath, INDEX_PATH);
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function removeFile(filePath: string) {
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function cleanupOrphanedAudioFiles(index: Record<string, StoredAudioRecord>) {
  await ensureStorage();
  const referenced = new Set(Object.values(index).flatMap((record) => [record.originalStoredName, record.playbackStoredName]));
  const entries = await readdir(AUDIO_DIRECTORY, { withFileTypes: true });
  const orphans = entries
    .filter((entry) => entry.isFile() && GENERATED_AUDIO_PATTERN.test(entry.name) && !referenced.has(entry.name))
    .map((entry) => path.join(AUDIO_DIRECTORY, entry.name));
  const cleanup = await Promise.allSettled(orphans.map(removeFile));
  if (cleanup.some((result) => result.status === "rejected")) {
    console.error("Een of meer achtergebleven audiobestanden konden niet worden opgeruimd.");
  }
}

async function transcodeToOpus(inputPath: string, outputPath: string) {
  await new Promise<void>((resolve, reject) => {
    const process = spawn(FFMPEG_PATH, [
      "-hide_banner",
      "-loglevel", "error",
      "-nostdin",
      "-y",
      "-i", inputPath,
      "-map", "0:a:0",
      "-map_metadata", "-1",
      "-vn",
      "-c:a", "libopus",
      "-b:a", "196k",
      "-vbr", "on",
      "-compression_level", "10",
      "-application", "audio",
      "-f", "webm",
      outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8000) stderr += chunk;
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      process.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);
    process.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      reject(new Error(error.code === "ENOENT" ? "FFmpeg is niet geïnstalleerd op de server." : "De audioconversie kon niet worden gestart."));
    });
    process.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error("De audioconversie duurde te lang en is gestopt."));
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() ? "Het bestand bevat geen bruikbare audiotrack." : "De audioconversie is mislukt."));
    });
  });
}

async function probeAudioDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const process = spawn(FFPROBE_PATH, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1000) stdout += chunk;
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      process.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);
    process.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      reject(new Error(error.code === "ENOENT" ? "FFprobe is niet geïnstalleerd op de server." : "De speelduur kon niet worden gelezen."));
    });
    process.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error("Het uitlezen van de speelduur duurde te lang en is gestopt."));
      const duration = Number(stdout.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error("Het audiobestand heeft geen geldige speelduur."));
    });
  });
}

export function validateTrackId(trackId: string | undefined): string {
  if (!trackId || !TRACK_ID_PATTERN.test(trackId)) throw new Error("Ongeldig nummer-id.");
  return trackId;
}

export function validateAudioFile(file: File) {
  if (!AUDIO_TYPES[file.type]) throw new Error("Gebruik een MP3-, M4A-, WAV-, OGG-, WebM-, AAC- of FLAC-bestand.");
  if (file.size <= 0) throw new Error("Het audiobestand is leeg.");
  if (file.size > MAX_AUDIO_BYTES) throw new Error("Het audiobestand mag maximaal 100 MB zijn.");
}

export async function listAudioRecords(): Promise<Record<string, AudioRecord>> {
  const index = await readIndex();
  const available = await Promise.all(Object.entries(index).map(async ([trackId, record]) => {
    try {
      await Promise.all([
        stat(path.join(AUDIO_DIRECTORY, record.originalStoredName)),
        stat(path.join(AUDIO_DIRECTORY, record.playbackStoredName)),
      ]);
      return [trackId, publicRecord(record)] as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }));
  return Object.fromEntries(available.filter((entry): entry is readonly [string, AudioRecord] => Boolean(entry)));
}

export async function getAudioAsset(trackId: string, original = false): Promise<AudioAsset | undefined> {
  const index = await readIndex();
  const record = index[trackId];
  if (!record) return undefined;
  const storedName = original ? record.originalStoredName : record.playbackStoredName;
  const filePath = path.join(AUDIO_DIRECTORY, storedName);
  try {
    const fileStat = await stat(filePath);
    return {
      record,
      path: filePath,
      size: fileStat.size,
      mimeType: original ? record.originalMimeType : record.playbackMimeType,
      downloadName: original ? record.originalName : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveAudio(
  trackId: string,
  file: File,
  details: { title: string; artist: string },
): Promise<AudioRecord> {
  validateTrackId(trackId);
  validateAudioFile(file);
  const title = details.title.trim().slice(0, 200);
  const artist = details.artist.trim().slice(0, 200);
  if (!title || !artist) throw new Error("Titel en artiest ontbreken.");
  const extension = AUDIO_TYPES[file.type];

  return enqueue(async () => {
    // Tijdens conversie staan origineel en browserversie tijdelijk naast een
    // eventuele oude upload. Controleer eerst of het bronbestand zelf past.
    await assertStorageCapacity(file.size);
    // Maak de extra kopie pas binnen de queue, zodat gelijktijdige uploads niet
    // allemaal tegelijk maximaal 100 MB extra werkgeheugen vasthouden.
    const buffer = new Uint8Array(await file.arrayBuffer());
    await ensureStorage();
    const index = await readIndex();
    await cleanupOrphanedAudioFiles(index);
    const previous = index[trackId];
    const uploadId = randomUUID();
    const uploadKey = uploadId.replaceAll("-", "");
    const originalStoredName = `${trackId}-${uploadKey}-o.${extension}`;
    const playbackStoredName = `${trackId}-${uploadKey}.webm`;
    const temporaryOriginal = path.join(AUDIO_DIRECTORY, `.${trackId}-${uploadId}-original.tmp`);
    const temporaryPlayback = path.join(AUDIO_DIRECTORY, `.${trackId}-${uploadId}-playback.tmp`);
    const finalOriginal = path.join(AUDIO_DIRECTORY, originalStoredName);
    const finalPlayback = path.join(AUDIO_DIRECTORY, playbackStoredName);
    let committed = false;

    try {
      await writeFile(temporaryOriginal, buffer);
      const duration = await probeAudioDuration(temporaryOriginal);
      // Een Opus-bestand op 196 kbit/s kan groter worden dan een sterk
      // gecomprimeerd bronbestand. Reserveer daarom op basis van speelduur.
      const expectedPlaybackSize = Math.ceil(duration * 196_000 / 8 * 1.25);
      await assertStorageCapacity(expectedPlaybackSize);
      await transcodeToOpus(temporaryOriginal, temporaryPlayback);
      await rename(temporaryOriginal, finalOriginal);
      await rename(temporaryPlayback, finalPlayback);
      const playbackStat = await stat(finalPlayback);

      const record: StoredAudioRecord = {
        trackId,
        title,
        artist,
        originalName: path.basename(file.name).slice(0, 200) || `audio.${extension}`,
        originalStoredName,
        originalMimeType: file.type,
        originalSize: file.size,
        playbackStoredName,
        playbackMimeType: "audio/webm",
        playbackSize: playbackStat.size,
        duration,
        uploadedAt: new Date().toISOString(),
      };
      index[trackId] = record;
      await writeIndex(index);
      committed = true;
      if (previous) {
        const oldNames = [previous.originalStoredName, previous.playbackStoredName]
          .filter((name) => name !== originalStoredName && name !== playbackStoredName);
        const cleanup = await Promise.allSettled(oldNames.map((name) => removeFile(path.join(AUDIO_DIRECTORY, name))));
        if (cleanup.some((result) => result.status === "rejected")) {
          console.error("Een oud audiobestand kon na een geslaagde vervanging niet worden opgeruimd.");
        }
      }
      return publicRecord(record);
    } finally {
      await Promise.all([removeFile(temporaryOriginal), removeFile(temporaryPlayback)]);
      if (!committed) await Promise.all([removeFile(finalOriginal), removeFile(finalPlayback)]);
    }
  });
}

export async function removeAudioBatch(trackIds: string[]): Promise<number> {
  const ids = [...new Set(trackIds.map((trackId) => validateTrackId(trackId)))];
  if (ids.length === 0) return 0;
  return enqueue(async () => {
    const index = await readIndex();
    await cleanupOrphanedAudioFiles(index);
    const records = ids.map((trackId) => index[trackId]).filter((record): record is StoredAudioRecord => Boolean(record));
    if (records.length === 0) return 0;
    for (const record of records) delete index[record.trackId];
    await writeIndex(index);
    const cleanup = await Promise.allSettled(records.flatMap((record) => [
      removeFile(path.join(AUDIO_DIRECTORY, record.originalStoredName)),
      removeFile(path.join(AUDIO_DIRECTORY, record.playbackStoredName)),
    ]));
    if (cleanup.some((result) => result.status === "rejected")) {
      console.error("Een of meer verwijderde audiobestanden konden niet volledig worden opgeruimd.");
    }
    return records.length;
  });
}

export async function removeAudio(trackId: string): Promise<boolean> {
  return (await removeAudioBatch([trackId])) > 0;
}
