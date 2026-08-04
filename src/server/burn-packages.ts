import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_DISC_SECONDS, TRACK_GAP_SECONDS } from "../data/disc-distribution";
import { formatDuration, type Track } from "../data/tracks";
import { getAudioAsset } from "./audio-storage";
import { getDiscLayout, type DiscLayout } from "./disc-layout-storage";
import { loadGroupData } from "./group-state";
import { calculateFinalRanking } from "./ranking";
import { assertStorageCapacity, STORAGE_ROOT } from "./storage-health";
import { ZipWriter } from "./zip-writer";

const DEFAULT_STORAGE_ROOT = STORAGE_ROOT;
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH ?? "ffprobe";
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const BURN_PACKAGE_VERSION = 2;

type AudioSource = { path: string; duration: number };
type OriginalAudioAsset = NonNullable<Awaited<ReturnType<typeof getAudioAsset>>>;

export type BurnPackageState = "preparing" | "ready" | "error";

export type BurnPackageStatus = {
  state: BurnPackageState;
  completedTracks: number;
  totalTracks: number;
  currentDisc: number | null;
  currentTrack: string | null;
  error: string | null;
  downloads: Array<{ id: "cd-1" | "cd-2" | "cd-3" | "all"; label: string; url: string; size: number }>;
};

type Job = { status: BurnPackageStatus; promise: Promise<void> };

const jobs = new Map<string, Job>();
const durationCache = new Map<string, { path: string; uploadedAt: string; duration: number }>();

export async function loadFinalBurnContext(): Promise<{ layout: DiscLayout; tracks: Track[] }> {
  const group = await loadGroupData();
  if (!group.status.votingComplete) throw new Error("De ranglijst staat nog niet vast.");
  const layout = await getDiscLayout();
  if (!layout?.finalizedAt) throw new Error("De cd-indeling is nog niet definitief.");
  const ranking = calculateFinalRanking(group.tracks, Object.values(group.voteChoices).flat());
  const expected = ranking.slice(0, 50).map((track) => track.id);
  if (layout.topTrackIds.length !== expected.length || layout.topTrackIds.some((id, index) => id !== expected[index])) {
    throw new Error("De cd-indeling hoort niet meer bij de huidige ranglijst.");
  }
  return { layout, tracks: group.tracks };
}

function packageKey(layout: DiscLayout): string {
  return createHash("sha256").update(JSON.stringify({ version: BURN_PACKAGE_VERSION, discs: layout.discs, finalizedAt: layout.finalizedAt })).digest("hex").slice(0, 24);
}

function packageDirectory(layout: DiscLayout, storageRoot = DEFAULT_STORAGE_ROOT): string {
  return path.join(storageRoot, "burn-packages", packageKey(layout));
}

function packageFiles(layout: DiscLayout, storageRoot = DEFAULT_STORAGE_ROOT) {
  const directory = packageDirectory(layout, storageRoot);
  return {
    directory,
    discs: [1, 2, 3].map((number) => path.join(directory, `cd-${String(number).padStart(2, "0")}.zip`)),
    all: path.join(directory, "alle-cds.zip"),
  };
}

async function run(command: string, args: string[], errorMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout += chunk);
    child.stderr.resume();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROCESS_TIMEOUT_MS);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      reject(new Error(error.code === "ENOENT" ? `${command} is niet geïnstalleerd op de server.` : errorMessage));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error(`${errorMessage} Het proces duurde te lang en is gestopt.`));
      if (code === 0) resolve(stdout);
      else reject(new Error(errorMessage));
    });
  });
}

async function probeDuration(filePath: string): Promise<number> {
  const output = await run(FFPROBE_PATH, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], "De werkelijke speelduur van een audiobestand kon niet worden gelezen.");
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Een audiobestand heeft geen geldige speelduur.");
  return duration;
}

export async function resolveBurnAudioSources(tracks: Track[]): Promise<Map<string, AudioSource>> {
  const assets = new Map<string, OriginalAudioAsset>();
  for (const track of tracks) {
    const asset = await getAudioAsset(track.id, true);
    if (!asset) throw new Error(`Het originele audiobestand van ${track.title} ontbreekt.`);
    assets.set(track.id, asset);
  }

  const activeTrackIds = new Set(assets.keys());
  for (const trackId of durationCache.keys()) {
    if (!activeTrackIds.has(trackId)) durationCache.delete(trackId);
  }
  const durations = new Map<string, number>();
  const assetsToProbe: Array<{ trackId: string; asset: OriginalAudioAsset }> = [];
  for (const [trackId, asset] of assets) {
    const cached = durationCache.get(trackId);
    if (cached?.path === asset.path && cached.uploadedAt === asset.record.uploadedAt) durations.set(asset.path, cached.duration);
    else assetsToProbe.push({ trackId, asset });
  }
  for (let offset = 0; offset < assetsToProbe.length; offset += 4) {
    const batch = assetsToProbe.slice(offset, offset + 4);
    const values = await Promise.all(batch.map(({ asset }) => probeDuration(asset.path)));
    batch.forEach(({ trackId, asset }, index) => {
      const duration = values[index];
      durations.set(asset.path, duration);
      durationCache.set(trackId, { path: asset.path, uploadedAt: asset.record.uploadedAt, duration });
    });
  }
  return new Map([...assets].map(([trackId, asset]) => [trackId, { path: asset.path, duration: durations.get(asset.path)! }]));
}

export async function validateBurnCapacity(layout: DiscLayout, tracks: Track[]): Promise<Map<string, AudioSource>> {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const ordered = layout.discs.flat().map((id) => trackById.get(id)).filter((track): track is Track => Boolean(track));
  if (ordered.length !== 50) throw new Error("De cd-indeling bevat niet alle vijftig nummers.");
  const sources = await resolveBurnAudioSources(ordered);
  layout.discs.forEach((disc, index) => {
    const audioSeconds = disc.reduce((total, id) => total + sources.get(id)!.duration, 0);
    const burnSeconds = audioSeconds + Math.max(0, disc.length - 1) * TRACK_GAP_SECONDS;
    if (burnSeconds > MAX_DISC_SECONDS) {
      throw new Error(`CD ${index + 1} duurt met de werkelijke audio en trackovergangen ${formatDuration(Math.ceil(burnSeconds))}. De top 50 past in deze volgorde niet binnen drie cd’s van 80 minuten.`);
    }
  });
  return sources;
}

function safeFilePart(value: string): string {
  const cleaned = value.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  return (cleaned || "Onbekend").slice(0, 90);
}

function cueValue(value: string): string {
  return value.replaceAll('"', "'").replace(/[\r\n]+/g, " ").trim();
}

function playlistValue(value: string): string {
  return value.replace(/[\r\n\u0000]+/g, " ").trim();
}

export function buildDiscMetadata(
  discNumber: number,
  firstTrackNumber: number,
  tracks: Track[],
  sources: Map<string, Pick<AudioSource, "duration">>,
  names: string[],
) {
  const folder = `CD ${String(discNumber).padStart(2, "0")}`;
  const total = tracks.reduce((sum, track) => sum + sources.get(track.id)!.duration, 0);
  const playlist = ["#EXTM3U", ...tracks.flatMap((track, index) => [
    `#EXTINF:${Math.round(sources.get(track.id)!.duration)},${playlistValue(track.artist)} - ${playlistValue(track.title)}`,
    names[index],
  ]), ""].join("\n");
  const cue = [
    "REM Gegenereerd door De gezamenlijke 50",
    `TITLE "${folder}"`,
    ...tracks.flatMap((track, index) => [
      `FILE "${cueValue(names[index])}" WAVE`,
      `  TRACK ${String(firstTrackNumber + index).padStart(2, "0")} AUDIO`,
      `    TITLE "${cueValue(track.title)}"`,
      `    PERFORMER "${cueValue(track.artist)}"`,
      "    INDEX 01 00:00:00",
    ]),
    "",
  ].join("\n");
  const tracklist = [
    `${folder} — De gezamenlijke 50`,
    `${tracks.length} nummers · ${formatDuration(Math.round(total))}`,
    "",
    ...tracks.map((track, index) => `${String(firstTrackNumber + index).padStart(2, "0")}. ${playlistValue(track.artist)} — ${playlistValue(track.title)} (${formatDuration(Math.round(sources.get(track.id)!.duration))})`),
    "",
    `Brand als audio-cd, niet als data-cd. Gebruik ${folder}.m3u8 om de bestanden in de juiste volgorde te laden.`,
    "De WAV-bestanden zijn vanuit de bewaarde originele audiobronnen omgezet naar 44,1 kHz, 16-bit stereo.",
    "",
  ].join("\r\n");
  const instructions = [
    `${folder} branden met doorlopende tracknummers`,
    "",
    `Deze cd bevat plek ${String(firstTrackNumber).padStart(2, "0")} tot en met ${String(firstTrackNumber + tracks.length - 1).padStart(2, "0")} van de gezamenlijke top 50.`,
    `Het eerste fysieke tracknummer op deze cd hoort daarom ${String(firstTrackNumber).padStart(2, "0")} te zijn.`,
    "",
    "Aanbevolen op Windows met VEGAS Pro:",
    "1. Importeer de WAV-bestanden en zet ze in bestandsnaamvolgorde op de tijdlijn.",
    "2. Kies Tools > Lay Out Audio CD from Events.",
    `3. Open Project Properties > Audio CD en zet First track number on disc op ${firstTrackNumber}.`,
    "4. Kies Tools > Burn Disc > Disc-at-Once Audio CD en controleer vóór het branden de volgorde.",
    "",
    `Het bestand ${folder}.cue bevat dezelfde doorlopende tracknummers voor andere brandprogramma's die dit ondersteunen.`,
    "Veel eenvoudige brandprogramma's beginnen iedere losse cd toch bij track 1. De bestandsnamen en afspeellijst blijven dan wel correct, maar het scherm van de cd-speler niet.",
    "Test de werkwijze bij voorkeur eerst met een cd-rw en controleer of de eerste track het nummer hierboven toont.",
    "",
  ].join("\r\n");
  return { folder, playlist, cue, tracklist, instructions };
}

async function transcodeToCdWav(sourcePath: string, outputPath: string) {
  await run(FFMPEG_PATH, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", sourcePath,
    "-map", "0:a:0", "-map_metadata", "-1", "-vn",
    "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le",
    outputPath,
  ], "Een nummer kon niet naar brandklare WAV-audio worden omgezet.");
}

async function createDiscPackage(
  outputPath: string,
  discNumber: number,
  firstTrackNumber: number,
  tracks: Track[],
  sources: Map<string, AudioSource>,
  status: BurnPackageStatus,
  packageRoot: string,
  modifiedAt: Date,
) {
  const temporaryZip = `${outputPath}.${randomUUID()}.tmp`;
  const writer = await ZipWriter.create(temporaryZip);
  const names = tracks.map((track, index) => `${String(firstTrackNumber + index).padStart(2, "0")} - ${safeFilePart(track.artist)} - ${safeFilePart(track.title)}.wav`);
  try {
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      const temporaryWav = path.join(packageRoot, `.${track.id}-${randomUUID()}.wav`);
      status.currentDisc = discNumber;
      status.currentTrack = `${track.artist} — ${track.title}`;
      try {
        await transcodeToCdWav(sources.get(track.id)!.path, temporaryWav);
        await writer.addFile(`CD ${String(discNumber).padStart(2, "0")}/${names[index]}`, temporaryWav, modifiedAt);
      } finally {
        await rm(temporaryWav, { force: true });
      }
      status.completedTracks += 1;
    }
    const metadata = buildDiscMetadata(discNumber, firstTrackNumber, tracks, sources, names);
    await writer.addBuffer(`${metadata.folder}/${metadata.folder}.m3u8`, metadata.playlist, modifiedAt);
    await writer.addBuffer(`${metadata.folder}/${metadata.folder}.cue`, metadata.cue, modifiedAt);
    await writer.addBuffer(`${metadata.folder}/Tracklijst.txt`, metadata.tracklist, modifiedAt);
    await writer.addBuffer(`${metadata.folder}/BRANDEN OP WINDOWS.txt`, metadata.instructions, modifiedAt);
    await writer.close();
    await rename(temporaryZip, outputPath);
  } catch (error) {
    await writer.abort().catch(() => undefined);
    await rm(temporaryZip, { force: true });
    throw error;
  }
}

async function createAllPackage(outputPath: string, discPaths: string[], modifiedAt: Date) {
  const temporaryZip = `${outputPath}.${randomUUID()}.tmp`;
  const writer = await ZipWriter.create(temporaryZip);
  try {
    for (let index = 0; index < discPaths.length; index += 1) {
      await writer.addFile(`CD ${String(index + 1).padStart(2, "0")}.zip`, discPaths[index], modifiedAt);
    }
    await writer.addBuffer("LEESMIJ.txt", [
      "Pak eerst dit archief uit. Daarna bevat iedere cd zijn eigen brandklare ZIP-bestand.",
      "De ranglijstvolgorde en nummering lopen door over alle drie cd's: open per cd BRANDEN OP WINDOWS.txt voordat je gaat branden.",
      "",
    ].join("\r\n"), modifiedAt);
    await writer.close();
    await rename(temporaryZip, outputPath);
  } catch (error) {
    await writer.abort().catch(() => undefined);
    await rm(temporaryZip, { force: true });
    throw error;
  }
}

async function downloadList(layout: DiscLayout, storageRoot = DEFAULT_STORAGE_ROOT): Promise<BurnPackageStatus["downloads"]> {
  const files = packageFiles(layout, storageRoot);
  const descriptors: BurnPackageStatus["downloads"] = [
    { id: "cd-1", label: "CD 1 downloaden", url: "/api/burn-packages/cd-1", size: 0 },
    { id: "cd-2", label: "CD 2 downloaden", url: "/api/burn-packages/cd-2", size: 0 },
    { id: "cd-3", label: "CD 3 downloaden", url: "/api/burn-packages/cd-3", size: 0 },
    { id: "all", label: "Alles downloaden", url: "/api/burn-packages/all", size: 0 },
  ];
  const paths = [...files.discs, files.all];
  const sizes = await Promise.all(paths.map((filePath) => stat(filePath).then((value) => value.size).catch(() => 0)));
  return descriptors.map((descriptor, index) => ({ ...descriptor, size: sizes[index] }));
}

async function packagesReady(layout: DiscLayout, storageRoot = DEFAULT_STORAGE_ROOT) {
  return (await downloadList(layout, storageRoot)).every((download) => download.size > 0);
}

function publicStatus(status: BurnPackageStatus): BurnPackageStatus {
  return { ...status, downloads: status.downloads.map((download) => ({ ...download })) };
}

export async function ensureBurnPackages(layout: DiscLayout, tracks: Track[], storageRoot = DEFAULT_STORAGE_ROOT): Promise<BurnPackageStatus> {
  if (!layout.finalizedAt) throw new Error("De cd-indeling is nog niet definitief.");
  if (await packagesReady(layout, storageRoot)) {
    return {
      state: "ready",
      completedTracks: 50,
      totalTracks: 50,
      currentDisc: null,
      currentTrack: null,
      error: null,
      downloads: await downloadList(layout, storageRoot),
    };
  }
  const jobKey = `${storageRoot}:${packageKey(layout)}`;
  const current = jobs.get(jobKey);
  if (current) return publicStatus(current.status);

  const status: BurnPackageStatus = {
    state: "preparing",
    completedTracks: 0,
    totalTracks: 50,
    currentDisc: 1,
    currentTrack: null,
    error: null,
    downloads: [],
  };
  const files = packageFiles(layout, storageRoot);
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const promise = (async () => {
    try {
      const orderedTracks = layout.discs.flat().map((id) => trackById.get(id)).filter((track): track is Track => Boolean(track));
      if (orderedTracks.length !== 50) throw new Error("De definitieve cd-indeling bevat niet alle vijftig nummers.");
      const sources = await validateBurnCapacity(layout, orderedTracks);
      const wavBytes = [...sources.values()].reduce((sum, source) => sum + source.duration * 44_100 * 2 * 2, 0);
      // De drie cd-zipbestanden en het overkoepelende zipbestand bevatten samen
      // ongeveer twee kopieën van alle ongecomprimeerde WAV-data.
      await assertStorageCapacity(Math.ceil(wavBytes * 2.05), storageRoot);
      await mkdir(files.directory, { recursive: true });
      const modifiedAt = new Date(layout.finalizedAt!);
      let firstTrackNumber = 1;
      for (let index = 0; index < 3; index += 1) {
        const discTracks = layout.discs[index].map((id) => trackById.get(id)!).filter(Boolean);
        await createDiscPackage(files.discs[index], index + 1, firstTrackNumber, discTracks, sources, status, files.directory, modifiedAt);
        firstTrackNumber += discTracks.length;
      }
      status.currentDisc = null;
      status.currentTrack = "Compleet pakket samenstellen";
      await createAllPackage(files.all, files.discs, modifiedAt);
      status.state = "ready";
      status.currentTrack = null;
      status.downloads = await downloadList(layout, storageRoot);
    } catch (error) {
      status.state = "error";
      status.currentDisc = null;
      status.currentTrack = null;
      status.error = error instanceof Error ? error.message : "De brandpakketten konden niet worden gemaakt.";
    }
  })();
  jobs.set(jobKey, { status, promise });
  void promise.then(() => {
    if (status.state === "ready") jobs.delete(jobKey);
  });
  return publicStatus(status);
}

export async function retryBurnPackages(layout: DiscLayout, tracks: Track[], storageRoot = DEFAULT_STORAGE_ROOT): Promise<BurnPackageStatus> {
  const jobKey = `${storageRoot}:${packageKey(layout)}`;
  const current = jobs.get(jobKey);
  if (current?.status.state === "preparing") return publicStatus(current.status);
  jobs.delete(jobKey);
  const files = packageFiles(layout, storageRoot);
  await rm(files.directory, { recursive: true, force: true });
  return ensureBurnPackages(layout, tracks, storageRoot);
}

export async function getBurnPackageFile(
  layout: DiscLayout,
  id: string,
  storageRoot = DEFAULT_STORAGE_ROOT,
): Promise<{ path: string; name: string; size: number } | undefined> {
  const files = packageFiles(layout, storageRoot);
  const options: Record<string, { path: string; name: string }> = {
    "cd-1": { path: files.discs[0], name: "De gezamenlijke 50 - CD 01.zip" },
    "cd-2": { path: files.discs[1], name: "De gezamenlijke 50 - CD 02.zip" },
    "cd-3": { path: files.discs[2], name: "De gezamenlijke 50 - CD 03.zip" },
    all: { path: files.all, name: "De gezamenlijke 50 - alle cd's.zip" },
  };
  const selected = options[id];
  if (!selected) return undefined;
  try {
    return { ...selected, size: (await stat(selected.path)).size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
