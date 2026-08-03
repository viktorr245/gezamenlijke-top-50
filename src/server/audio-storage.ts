import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR ?? process.env.AUDIO_STORAGE_DIR ?? path.join(process.cwd(), "storage"));
const AUDIO_DIRECTORY = path.join(STORAGE_ROOT, "audio");
const INDEX_PATH = path.join(STORAGE_ROOT, "audio-index.json");
const TRACK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? "ffmpeg";

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
  const storedNamePattern = /^[a-zA-Z0-9_-]{1,120}\.[a-z0-9]{2,5}$/;
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
    process.once("error", (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === "ENOENT" ? "FFmpeg is niet geïnstalleerd op de server." : "De audioconversie kon niet worden gestart."));
    });
    process.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() ? "Het bestand bevat geen bruikbare audiotrack." : "De audioconversie is mislukt."));
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
  const originalStoredName = `${trackId}-original.${extension}`;
  const playbackStoredName = `${trackId}.webm`;
  const buffer = new Uint8Array(await file.arrayBuffer());

  return enqueue(async () => {
    await ensureStorage();
    const index = await readIndex();
    const previous = index[trackId];
    const uploadId = randomUUID();
    const temporaryOriginal = path.join(AUDIO_DIRECTORY, `.${trackId}-${uploadId}-original.tmp`);
    const temporaryPlayback = path.join(AUDIO_DIRECTORY, `.${trackId}-${uploadId}-playback.tmp`);
    const finalOriginal = path.join(AUDIO_DIRECTORY, originalStoredName);
    const finalPlayback = path.join(AUDIO_DIRECTORY, playbackStoredName);

    try {
      await writeFile(temporaryOriginal, buffer);
      await transcodeToOpus(temporaryOriginal, temporaryPlayback);
      await rename(temporaryOriginal, finalOriginal);
      await rename(temporaryPlayback, finalPlayback);
      const playbackStat = await stat(finalPlayback);

      if (previous) {
        for (const oldName of [previous.originalStoredName, previous.playbackStoredName]) {
          if (oldName !== originalStoredName && oldName !== playbackStoredName) await removeFile(path.join(AUDIO_DIRECTORY, oldName));
        }
      }

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
        uploadedAt: new Date().toISOString(),
      };
      index[trackId] = record;
      await writeIndex(index);
      return publicRecord(record);
    } finally {
      await Promise.all([removeFile(temporaryOriginal), removeFile(temporaryPlayback)]);
    }
  });
}

export async function removeAudio(trackId: string): Promise<boolean> {
  validateTrackId(trackId);
  return enqueue(async () => {
    const index = await readIndex();
    const record = index[trackId];
    if (!record) return false;
    await Promise.all([
      removeFile(path.join(AUDIO_DIRECTORY, record.originalStoredName)),
      removeFile(path.join(AUDIO_DIRECTORY, record.playbackStoredName)),
    ]);
    delete index[trackId];
    await writeIndex(index);
    return true;
  });
}
