import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertStorageCapacity, STORAGE_ROOT } from "./storage-health";

const MAX_AUDIO_BYTES = 300 * 1024 * 1024;
const AUDIO_DIRECTORY = path.join(STORAGE_ROOT, "audio");
const INDEX_PATH = path.join(STORAGE_ROOT, "audio-index.json");
const TRACK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH ?? "ffprobe";
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000;
const YT_DLP_TIMEOUT_MS = 15 * 60 * 1000;
const GENERATED_AUDIO_PATTERN = /^[a-zA-Z0-9_-]{1,100}-[a-f0-9]{32}(?:-o)?\.[a-z0-9]{2,5}$/;
const TEMPORARY_AUDIO_PATTERN = /^\.[a-zA-Z0-9_-]{1,100}-[a-f0-9-]{36}-(?:original|playback)\.tmp$/;
const WORKING_AUDIO_PATTERN = /^\.audio-work-[a-f0-9-]{36}$/;

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

const EXTENSION_TYPES: Record<string, string> = {
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
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
  source?: "upload" | "youtube";
  sourceUrl?: string;
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
    && typeof record.uploadedAt === "string"
    && (record.source === undefined || record.source === "upload" || record.source === "youtube")
    && (record.sourceUrl === undefined || typeof record.sourceUrl === "string"),
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
  const orphanedFiles = entries
    .filter((entry) => entry.isFile() && (
      TEMPORARY_AUDIO_PATTERN.test(entry.name)
      || (GENERATED_AUDIO_PATTERN.test(entry.name) && !referenced.has(entry.name))
    ))
    .map((entry) => path.join(AUDIO_DIRECTORY, entry.name));
  const orphanedDirectories = entries
    .filter((entry) => entry.isDirectory() && WORKING_AUDIO_PATTERN.test(entry.name))
    .map((entry) => path.join(AUDIO_DIRECTORY, entry.name));
  const cleanup = await Promise.allSettled([
    ...orphanedFiles.map(removeFile),
    ...orphanedDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  ]);
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

function videoIdFromYouTubeUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2_048) {
    throw new Error("Plak een geldige YouTube-link.");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Plak een geldige YouTube-link.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Gebruik een volledige https-link van YouTube.");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  let videoId: string | null = null;
  if (host === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    if (url.pathname === "/watch") videoId = url.searchParams.get("v");
    else videoId = /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    throw new Error("Gebruik een link naar één YouTube-video, niet naar een kanaal of afspeellijst.");
  }
  return videoId;
}

export function normalizeYouTubeUrl(value: unknown): string {
  return `https://www.youtube.com/watch?v=${videoIdFromYouTubeUrl(value)}`;
}

function runYtDlp(url: string, outputTemplate: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.YTDLP_PATH ?? "yt-dlp", [
      "--no-config",
      "--no-plugin-dirs",
      "--no-update",
      "--no-playlist",
      "--no-progress",
      "--no-cache-dir",
      "--no-part",
      "--socket-timeout", "20",
      "--retries", "3",
      "--fragment-retries", "3",
      "--max-filesize", "300M",
      "--no-js-runtimes",
      "--js-runtimes", "node",
      "--use-extractors", "youtube",
      "--format", "bestaudio[filesize<=300M]/bestaudio[filesize_approx<=300M]/bestaudio",
      "--output", outputTemplate,
      url,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_000) stderr += chunk;
    });
    let settled = false;
    let timedOut = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, YT_DLP_TIMEOUT_MS);
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(new Error(error.code === "ENOENT" ? "yt-dlp is niet geïnstalleerd op de server." : "De YouTube-download kon niet worden gestart."));
    });
    child.once("close", (code) => {
      if (timedOut) return finish(new Error("De YouTube-download duurde te lang en is gestopt."));
      if (code === 0) return finish();
      const normalizedError = stderr.toLocaleLowerCase("en-US");
      if (normalizedError.includes("larger than max-filesize") || normalizedError.includes("max-filesize")) {
        return finish(new Error("De YouTube-audio is groter dan 300 MB."));
      }
      if (normalizedError.includes("video unavailable") || normalizedError.includes("private video") || normalizedError.includes("sign in")) {
        return finish(new Error("Deze YouTube-video is niet openbaar beschikbaar."));
      }
      finish(new Error("De audio kon niet van YouTube worden opgehaald. Controleer de link en probeer het opnieuw."));
    });
  });
}

type PreparedAudioSource = {
  path: string;
  extension: string;
  mimeType: string;
  originalName: string;
  source: "upload" | "youtube";
  sourceUrl?: string;
};

function safeOriginalName(value: string, fallback: string): string {
  const name = path.basename(value.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (name || fallback).slice(0, 200);
}

function safeGeneratedOriginalName(value: string, fallback: string): string {
  const name = value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-").replace(/\s+/g, " ").trim();
  return (name || fallback).slice(0, 200);
}

async function savePreparedAudio(
  trackId: string,
  details: { title: string; artist: string },
  reservedBytes: number,
  prepare: (workingDirectory: string) => Promise<PreparedAudioSource>,
): Promise<AudioRecord> {
  validateTrackId(trackId);
  const title = details.title.trim().slice(0, 200);
  const artist = details.artist.trim().slice(0, 200);
  if (!title || !artist) throw new Error("Titel en artiest ontbreken.");

  return enqueue(async () => {
    await assertStorageCapacity(reservedBytes);
    await ensureStorage();
    const index = await readIndex();
    await cleanupOrphanedAudioFiles(index);
    const previous = index[trackId];
    const uploadId = randomUUID();
    const uploadKey = uploadId.replaceAll("-", "");
    const workingDirectory = path.join(AUDIO_DIRECTORY, `.audio-work-${uploadId}`);
    const temporaryOriginal = path.join(AUDIO_DIRECTORY, `.${trackId}-${uploadId}-original.tmp`);
    const temporaryPlayback = path.join(AUDIO_DIRECTORY, `.${trackId}-${uploadId}-playback.tmp`);
    let finalOriginal = "";
    let finalPlayback = "";
    let committed = false;

    await mkdir(workingDirectory, { recursive: false });
    try {
      const source = await prepare(workingDirectory);
      const sourceStat = await stat(source.path);
      if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error("Het audiobestand is leeg.");
      if (sourceStat.size > MAX_AUDIO_BYTES) throw new Error("Het audiobestand mag maximaal 300 MB zijn.");
      if (!EXTENSION_TYPES[source.extension] || !AUDIO_TYPES[source.mimeType]) {
        throw new Error("De gevonden audio heeft geen ondersteund bestandsformaat.");
      }

      const originalStoredName = `${trackId}-${uploadKey}-o.${source.extension}`;
      const playbackStoredName = `${trackId}-${uploadKey}.webm`;
      finalOriginal = path.join(AUDIO_DIRECTORY, originalStoredName);
      finalPlayback = path.join(AUDIO_DIRECTORY, playbackStoredName);
      await rename(source.path, temporaryOriginal);
      const duration = await probeAudioDuration(temporaryOriginal);
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
        originalName: source.originalName,
        originalStoredName,
        originalMimeType: source.mimeType,
        originalSize: sourceStat.size,
        playbackStoredName,
        playbackMimeType: "audio/webm",
        playbackSize: playbackStat.size,
        duration,
        uploadedAt: new Date().toISOString(),
        source: source.source,
        ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
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
      await Promise.all([
        rm(workingDirectory, { recursive: true, force: true }),
        removeFile(temporaryOriginal),
        removeFile(temporaryPlayback),
      ]);
      if (!committed) {
        await Promise.all([finalOriginal, finalPlayback].filter(Boolean).map(removeFile));
      }
    }
  });
}

export function validateTrackId(trackId: string | undefined): string {
  if (!trackId || !TRACK_ID_PATTERN.test(trackId)) throw new Error("Ongeldig nummer-id.");
  return trackId;
}

export function validateAudioFile(file: File) {
  if (!AUDIO_TYPES[file.type]) throw new Error("Gebruik een MP3-, M4A-, WAV-, OGG-, WebM-, AAC- of FLAC-bestand.");
  if (file.size <= 0) throw new Error("Het audiobestand is leeg.");
  if (file.size > MAX_AUDIO_BYTES) throw new Error("Het audiobestand mag maximaal 300 MB zijn.");
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
  validateAudioFile(file);
  const extension = AUDIO_TYPES[file.type];
  return savePreparedAudio(trackId, details, file.size, async (workingDirectory) => {
    const sourcePath = path.join(workingDirectory, `upload.${extension}`);
    await writeFile(sourcePath, new Uint8Array(await file.arrayBuffer()));
    return {
      path: sourcePath,
      extension,
      mimeType: file.type,
      originalName: safeOriginalName(file.name, `audio.${extension}`),
      source: "upload",
    };
  });
}

export async function saveAudioFromYouTube(
  trackId: string,
  youtubeUrl: unknown,
  details: { title: string; artist: string },
): Promise<AudioRecord> {
  const sourceUrl = normalizeYouTubeUrl(youtubeUrl);
  return savePreparedAudio(trackId, details, MAX_AUDIO_BYTES, async (workingDirectory) => {
    await runYtDlp(sourceUrl, path.join(workingDirectory, "source.%(ext)s"));
    const entries = (await readdir(workingDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith("source."));
    if (entries.length !== 1) throw new Error("De YouTube-download leverde geen bruikbaar audiobestand op.");
    const sourcePath = path.join(workingDirectory, entries[0].name);
    const extension = path.extname(entries[0].name).slice(1).toLowerCase();
    const mimeType = EXTENSION_TYPES[extension];
    if (!mimeType) throw new Error("De gevonden YouTube-audio heeft geen ondersteund bestandsformaat.");
    const videoId = videoIdFromYouTubeUrl(sourceUrl);
    const originalName = safeGeneratedOriginalName(`${details.artist} - ${details.title} (YouTube ${videoId}).${extension}`, `youtube-audio.${extension}`);
    return {
      path: sourcePath,
      extension,
      mimeType,
      originalName,
      source: "youtube",
      sourceUrl,
    };
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
