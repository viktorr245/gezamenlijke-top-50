import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { members, type MemberId, type Track } from "../src/data/tracks";
import { finalizeDiscLayout, getDiscLayout, saveDiscLayout } from "../src/server/disc-layout-storage";
import { listPinnedITunesTracks, pinITunesTrack, searchITunes } from "../src/server/itunes-cache";
import { calculateRanking } from "../src/server/ranking";
import { finalizeSubmission, getSubmission, listSubmissions, saveDraftSubmission, type SubmissionIndex } from "../src/server/submission-storage";
import { buildComparisonSchedules, type VoteChoice } from "../src/server/vote-storage";
import { ZipWriter } from "../src/server/zip-writer";

function makeTrack(owner: MemberId, index: number): Track {
  return {
    id: `${owner}-${String(index).padStart(2, "0")}`,
    title: `Nummer ${index + 1} van ${owner}`,
    artist: `Artiest ${owner}`,
    album: `Album ${owner}`,
    owner,
    duration: 150 + index,
    cover: "/covers/dreams.webp",
  };
}

function createWav(durationSeconds = 1): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * durationSeconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function storedZipContents(value: Buffer): Map<string, Buffer> {
  const endOffset = value.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error("ZIP-eindrecord ontbreekt.");
  const count = value.readUInt16LE(endOffset + 10);
  let offset = value.readUInt32LE(endOffset + 16);
  const result = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (value.readUInt32LE(offset) !== 0x02014b50) throw new Error("Ongeldig centraal ZIP-record.");
    expect(value.readUInt16LE(offset + 10)).toBe(0);
    const size = value.readUInt32LE(offset + 20);
    const nameLength = value.readUInt16LE(offset + 28);
    const extraLength = value.readUInt16LE(offset + 30);
    const commentLength = value.readUInt16LE(offset + 32);
    const localOffset = value.readUInt32LE(offset + 42);
    const name = value.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (value.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Ongeldig lokaal ZIP-record.");
    const localNameLength = value.readUInt16LE(localOffset + 26);
    const localExtraLength = value.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    result.set(name, value.subarray(dataOffset, dataOffset + size));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

function completeSubmissions(): SubmissionIndex {
  return Object.fromEntries(members.map((member) => [member.id, {
    memberId: member.id,
    tracks: Array.from({ length: 20 }, (_, index) => makeTrack(member.id, index)),
    updatedAt: "2026-08-03T00:00:00.000Z",
    finalizedAt: "2026-08-03T00:00:00.000Z",
  }])) as SubmissionIndex;
}

function groupStatus(overrides: Record<string, unknown> = {}) {
  return {
    phase: "inzenden",
    readyForVoting: false,
    votingComplete: false,
    finalizedCount: 0,
    completedVoterCount: 0,
    totalTracks: 0,
    members: members.map((member) => ({
      memberId: member.id,
      trackCount: 0,
      audioCount: 0,
      finalized: false,
      voteCount: 0,
      votingDone: false,
    })),
    ...overrides,
  };
}

function votingPayload(voteCount = 0) {
  const left = makeTrack("daniel", 0);
  const right = makeTrack("keano", 0);
  return {
    status: groupStatus({ readyForVoting: true, phase: "stemmen", finalizedCount: 5 }),
    member: { memberId: "viktor", trackCount: 20, audioCount: 20, finalized: true, voteCount, votingDone: voteCount === 120 },
    comparison: voteCount < 120 ? { id: `comparison-${voteCount}`, voterId: "viktor", leftId: left.id, rightId: right.id } : null,
    tracks: voteCount < 120 ? { left, right } : null,
    canUndo: voteCount > 0,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("gezamenlijke-top-50-member")) localStorage.setItem("gezamenlijke-top-50-member", "viktor");
  });
  await page.route("**/api/status", (route) => route.fulfill({ json: { status: groupStatus() } }));
});

test("het vaste vergelijkingsschema is exact gebalanceerd", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const submissions = completeSubmissions();
  const schedules = buildComparisonSchedules(submissions);
  const globalPairs = new Set<string>();
  const appearances = new Map<string, number>();
  const leftAppearances = new Map<string, number>();

  for (const member of members) {
    const schedule = schedules[member.id];
    expect(schedule).toHaveLength(120);
    const perVoter = new Map<string, number>();
    schedule.forEach((comparison, index) => {
      expect(comparison.voterId).toBe(member.id);
      expect(submissions[member.id].tracks.some((track) => track.id === comparison.leftId || track.id === comparison.rightId)).toBe(false);
      const key = [comparison.leftId, comparison.rightId].sort().join("|");
      expect(globalPairs.has(key)).toBe(false);
      globalPairs.add(key);
      for (const id of [comparison.leftId, comparison.rightId]) {
        appearances.set(id, (appearances.get(id) ?? 0) + 1);
        perVoter.set(id, (perVoter.get(id) ?? 0) + 1);
      }
      leftAppearances.set(comparison.leftId, (leftAppearances.get(comparison.leftId) ?? 0) + 1);
      if (index > 0) {
        const previous = schedule[index - 1];
        expect([previous.leftId, previous.rightId]).not.toContain(comparison.leftId);
        expect([previous.leftId, previous.rightId]).not.toContain(comparison.rightId);
      }
    });
    expect([...perVoter.values()].every((count) => count === 3)).toBe(true);
  }
  expect(globalPairs.size).toBe(600);
  expect([...appearances.values()].every((count) => count === 12)).toBe(true);
  expect([...leftAppearances.values()].every((count) => count === 6)).toBe(true);
});

test("de batchranglijst is deterministisch en onafhankelijk van invoervolgorde", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const submissions = completeSubmissions();
  const schedules = buildComparisonSchedules(submissions);
  const quality = new Map(members.flatMap((member, ownerIndex) => submissions[member.id].tracks.map((track, index) => [track.id, ownerIndex * 20 + index])));
  const choices: VoteChoice[] = Object.values(schedules).flat().map((comparison) => {
    const winnerId = quality.get(comparison.leftId)! < quality.get(comparison.rightId)! ? comparison.leftId : comparison.rightId;
    return { ...comparison, winnerId, loserId: winnerId === comparison.leftId ? comparison.rightId : comparison.leftId, chosenAt: "2026-08-03T00:00:00.000Z" };
  });
  const tracks = members.flatMap((member) => submissions[member.id].tracks);
  const first = calculateRanking(tracks, choices, 300);
  const second = calculateRanking([...tracks].reverse(), [...choices].reverse(), 300);
  expect(first).toHaveLength(100);
  expect(first.filter((track) => track.selected)).toHaveLength(50);
  expect(first.map((track) => track.id)).toEqual(second.map((track) => track.id));
  expect(first[0].top50Probability).toBeGreaterThan(first[99].top50Probability);
  expect(first.every((track) => track.rankLow <= track.expectedRank && track.expectedRank <= track.rankHigh)).toBe(true);
});

test("inzendingen bewaren concepten, blokkeren groepsdubbelen en vergrendelen definitief", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const directory = await mkdtemp(path.join(tmpdir(), "top50-submissions-"));
  const storagePath = path.join(directory, "submissions.json");
  try {
    const viktorTracks = Array.from({ length: 20 }, (_, index) => makeTrack("viktor", index));
    const draft = await saveDraftSubmission("viktor", viktorTracks.slice(0, 3), storagePath);
    expect(draft.tracks).toHaveLength(3);
    const duplicate = { ...viktorTracks[0], owner: "daniel" as const };
    await expect(saveDraftSubmission("daniel", [duplicate], storagePath)).rejects.toThrow(/al in de lijst/);
    await saveDraftSubmission("daniel", [makeTrack("daniel", 0)], storagePath);
    expect((await listSubmissions(storagePath)).daniel?.tracks).toHaveLength(1);
    const final = await finalizeSubmission("viktor", viktorTracks, storagePath);
    expect(final.finalizedAt).not.toBeNull();
    expect((await getSubmission("viktor", storagePath))?.tracks).toHaveLength(20);
    await expect(saveDraftSubmission("viktor", [], storagePath)).rejects.toThrow(/al definitief/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("een cd-indeling bevat exact de top 50 en wordt definitief vergrendeld", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const directory = await mkdtemp(path.join(tmpdir(), "top50-discs-"));
  const storagePath = path.join(directory, "layout.json");
  const tracks = members.flatMap((member) => Array.from({ length: 10 }, (_, index) => makeTrack(member.id, index)));
  const ids = tracks.map((track) => track.id);
  const discs = [ids.slice(0, 17), ids.slice(17, 34), ids.slice(34)];
  try {
    await saveDiscLayout(discs, ids, storagePath);
    const final = await finalizeDiscLayout(tracks, ids, storagePath);
    expect(final.finalizedAt).not.toBeNull();
    expect((await getDiscLayout(storagePath))?.discs.flat()).toHaveLength(50);
    await expect(saveDiscLayout(discs, ids, storagePath)).rejects.toThrow(/al definitief/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("de ZIP-schrijver bewaart UTF-8-bestandsnamen en audiobestanden zonder alles in het geheugen te verzamelen", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const directory = await mkdtemp(path.join(tmpdir(), "top50-zip-"));
  const sourcePath = path.join(directory, "bron.wav");
  const zipPath = path.join(directory, "cd.zip");
  try {
    const audio = createWav();
    await writeFile(sourcePath, audio);
    const writer = await ZipWriter.create(zipPath);
    await writer.addFile("CD 01/01 - Björk - Jóga.wav", sourcePath, new Date("2026-08-03T00:00:00Z"));
    await writer.addBuffer("CD 01/CD 01.m3u8", "#EXTM3U\n01 - Björk - Jóga.wav\n", new Date("2026-08-03T00:00:00Z"));
    await writer.close();
    const contents = storedZipContents(await readFile(zipPath));
    expect(contents.get("CD 01/01 - Björk - Jóga.wav")).toEqual(audio);
    expect(contents.get("CD 01/CD 01.m3u8")?.toString("utf8")).toContain("Björk");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("iTunes-zoekresultaten worden gecachet en volledig vastgezet", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const directory = await mkdtemp(path.join(tmpdir(), "top50-itunes-"));
  const cachePath = path.join(directory, "itunes.json");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return Response.json({ results: [{
      kind: "song",
      trackId: 12345,
      trackName: "Testnummer",
      artistName: "Testartiest",
      collectionName: "Testalbum",
      trackTimeMillis: 201000,
      artworkUrl100: "https://example.test/100x100bb.jpg",
      previewUrl: "https://example.test/preview.m4a",
      releaseDate: "2025-01-01T00:00:00Z",
    }] });
  };
  try {
    expect((await searchITunes("testnummer", fetcher, cachePath)).cacheStatus).toBe("MISS");
    expect((await searchITunes("  TESTNUMMER ", fetcher, cachePath)).cacheStatus).toBe("HIT");
    expect(calls).toBe(1);
    await pinITunesTrack("12345", cachePath);
    expect(await listPinnedITunesTracks(cachePath)).toHaveLength(1);
    const stored = JSON.parse(await readFile(cachePath, "utf8"));
    expect(stored.records["12345"].raw.releaseDate).toBe("2025-01-01T00:00:00Z");
    expect(stored.records["12345"].pinnedAt).toBeTruthy();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audio bewaart het origineel en maakt een Opus-afspeelbestand", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const directory = await mkdtemp(path.join(tmpdir(), "top50-audio-"));
  const previousStorage = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = directory;
  try {
    const storage = await import("../src/server/audio-storage");
    const wav = createWav();
    const record = await storage.saveAudio("audio-test", new File([Uint8Array.from(wav)], "origineel.wav", { type: "audio/wav" }), {
      title: "Testnummer",
      artist: "Testartiest",
    });
    expect(record.originalSize).toBe(wav.length);
    expect(record.playbackMimeType).toBe("audio/webm");
    expect(record.playbackSize).toBeGreaterThan(0);
    const original = await storage.getAudioAsset("audio-test", true);
    const playback = await storage.getAudioAsset("audio-test");
    expect(original?.mimeType).toBe("audio/wav");
    expect(playback?.mimeType).toBe("audio/webm");
    expect(await readFile(original!.path)).toEqual(wav);
  } finally {
    if (previousStorage === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorage;
    await rm(directory, { recursive: true, force: true });
  }
});

test("de navigatie en deelnemerkeuze werken op ieder scherm", async ({ page, isMobile }) => {
  await page.route("**/api/voting/*", (route) => route.fulfill({ json: votingPayload() }));
  await page.route("**/api/submissions/*", (route) => route.fulfill({ json: { submission: null } }));
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: {} } }));
  await page.route("**/api/ranking", (route) => route.fulfill({ json: { status: groupStatus(), ranking: null } }));
  await page.route("**/api/disc-layout", (route) => route.fulfill({ json: { status: groupStatus(), layout: null, tracks: [], organizerId: "viktor" } }));
  await page.goto("/stemmen");
  const nav = page.locator(isMobile ? ".bottom-nav" : ".side-nav");
  for (const [name, path] of [["Mijn 20", "/mijn-20"], ["Ranglijst", "/ranglijst"], ["De cd’s", "/cds"], ["Stemmen", "/stemmen"]] as const) {
    await nav.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
  if (isMobile) {
    await page.locator("[data-member-select]").selectOption("daniel");
  } else {
    await page.locator('[data-member-id="daniel"]').click();
  }
  await expect.poll(async () => {
    try { return await page.evaluate(() => localStorage.getItem("gezamenlijke-top-50-member")); }
    catch { return null; }
  }).toBe("daniel");
});

test("stemmen gebruikt 120 markeringen, centrale audio en ondersteunt één stap terug", async ({ page }) => {
  let voteCount = 7;
  await page.route("**/api/voting/viktor", async (route) => {
    if (route.request().method() === "POST") voteCount += 1;
    if (route.request().method() === "DELETE") voteCount -= 1;
    await route.fulfill({ json: votingPayload(voteCount) });
  });
  await page.goto("/stemmen");
  await expect(page.locator(".progress-mark")).toHaveCount(120);
  await expect(page.locator(".progress-mark.complete")).toHaveCount(7);
  await expect(page.locator("#vote-grid")).toBeVisible();
  await expect(page.locator('[data-choice="left"] [data-title]')).toContainText("Nummer 1");
  await page.locator('[data-choice="left"] [data-vote]').click();
  await expect(page.locator("#vote-count")).toHaveText("8");
  await expect(page.locator("#undo-vote")).toBeVisible();
  await page.locator("#undo-vote").click();
  await expect(page.locator("#vote-count")).toHaveText("7");
});

test("Mijn 20 zoekt, bewaart centraal en maakt audio duidelijk verplicht", async ({ page, isMobile }) => {
  let draft: Track[] = [];
  await page.route("**/api/submissions/viktor", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { submission: null } });
    const body = route.request().postDataJSON() as { tracks: Track[] };
    draft = body.tracks;
    await route.fulfill({ json: { submission: { memberId: "viktor", tracks: draft, updatedAt: new Date().toISOString(), finalizedAt: null } } });
  });
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: {} } }));
  const result = { ...makeTrack("viktor", 0), id: "itunes-100000", source: "itunes" as const, sourceId: "100000", previewUrl: "https://example.test/preview.m4a" };
  await page.route("**/api/itunes/search?**", (route) => route.fulfill({ json: { tracks: [result] } }));
  await page.route("**/api/itunes/catalog", (route) => route.fulfill({ json: { track: result } }));
  await page.goto("/mijn-20");
  const input = page.locator("#track-search");
  await expect(input).toBeEnabled();
  await input.fill("nummer");
  await page.locator("#add-track-form").getByRole("button", { name: "Zoeken" }).click();
  if (isMobile) {
    for (const control of [page.locator(".search-preview"), page.locator(".search-add")]) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.getByRole("button", { name: "Voeg toe" }).click();
  await expect(page.locator(".submission-row")).toHaveCount(1);
  await expect(page.locator(".audio-required")).toContainText("Audio ontbreekt");
  await expect(page.locator("#submission-audio-progress")).toHaveText("0 van 20 met audio");
  await expect.poll(() => draft.length).toBe(1);
  await expect(page.locator(".reorder-controls")).toHaveCount(0);
  await expect(page.locator("#save-submission")).toBeDisabled();
  if (isMobile) {
    for (const control of [page.locator(".row-cover-button"), page.locator(".remove-track"), page.locator(".audio-upload-action")]) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  }
});

test("een nummer uit een concept verwijderen ruimt beide server-audiobestanden op", async ({ page }) => {
  const track = { ...makeTrack("viktor", 0), id: "itunes-100000", source: "itunes" as const, sourceId: "100000" };
  let draft = [track];
  let audioDeleted = false;
  await page.route("**/api/submissions/viktor", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { submission: { memberId: "viktor", tracks: draft, updatedAt: new Date().toISOString(), finalizedAt: null } } });
    }
    draft = (route.request().postDataJSON() as { tracks: typeof draft }).tracks;
    return route.fulfill({ json: { submission: { memberId: "viktor", tracks: draft, updatedAt: new Date().toISOString(), finalizedAt: null } } });
  });
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: {
    [track.id]: {
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      originalName: "origineel.flac",
      mimeType: "audio/webm",
      size: 1234,
      uploadedAt: new Date().toISOString(),
      url: `/api/audio/${track.id}`,
    },
  } } }));
  await page.route(`**/api/audio/${track.id}?**`, async (route) => {
    audioDeleted = route.request().method() === "DELETE";
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/mijn-20");
  await expect(page.locator(".audio-ready-label")).toContainText("Audio toegevoegd");
  await page.locator(".remove-track").click();
  await expect(page.locator(".submission-row")).toHaveCount(0);
  await expect.poll(() => audioDeleted).toBe(true);
  await expect.poll(() => draft.length).toBe(0);
});

test("de definitieve ranglijst toont alle 100 nummers en de grens", async ({ page, isMobile }) => {
  const tracks = members.flatMap((member) => Array.from({ length: 20 }, (_, index) => makeTrack(member.id, index)));
  const ranking = tracks.map((track, index) => ({
    ...track,
    rank: index + 1,
    selected: index < 50,
    strength: 1 - index / 100,
    top50Probability: Math.max(0, 1 - index / 99),
    expectedRank: index + 1,
    rankLow: Math.max(1, index - 2),
    rankHigh: Math.min(100, index + 4),
    winRate: 0.5,
    leaveOneOutSelections: index < 50 ? 5 : 0,
  }));
  const status = groupStatus({ votingComplete: true, completedVoterCount: 5, finalizedCount: 5, phase: "ranglijst", members: groupStatus().members.map((member) => ({ ...member, votingDone: true, voteCount: 120 })) });
  await page.route("**/api/ranking", (route) => route.fulfill({ json: { status, ranking } }));
  await page.goto("/ranglijst");
  await expect(page.locator(".ranking-row")).toHaveCount(100);
  await expect(page.locator(".cutoff-marker")).toHaveCount(1);
  await expect(page.locator(".ranking-columns")).toContainText("Kans top 50");
  await expect(page.locator(".ranking-row.outside")).toHaveCount(50);
  await expect(page.locator(".rank-uncertainty")).toHaveCount(100);
  await expect(page.locator(".rank-uncertainty").first()).toContainText("90%: plek");
  const cutoffMargins = await page.locator(".cutoff-marker").evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.marginTop, style.marginBottom];
  });
  expect(cutoffMargins[0]).toBe(cutoffMargins[1]);
  if (!isMobile) {
    await page.locator(".page").evaluate((element) => element.scrollTop = 800);
    await expect.poll(async () => Math.round((await page.locator(".ranking-columns").boundingBox())?.y ?? -1)).toBe(0);
  }
});

test("de cd-pagina verdeelt automatisch, ordent toegankelijk en laat alleen Viktor afronden", async ({ page, isMobile }) => {
  const topTracks = members.flatMap((member) => Array.from({ length: 10 }, (_, index) => makeTrack(member.id, index)));
  const status = groupStatus({ votingComplete: true, completedVoterCount: 5, finalizedCount: 5, phase: "ranglijst" });
  let layout: { discs: string[][]; topTrackIds: string[]; updatedAt: string; finalizedAt: string | null } | null = null;
  await page.route("**/api/disc-layout", async (route) => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: { status, layout, tracks: topTracks, organizerId: "viktor" } });
    if (method === "PUT") {
      const body = route.request().postDataJSON() as { discs: string[][] };
      layout = { discs: body.discs, topTrackIds: topTracks.map((track) => track.id), updatedAt: new Date().toISOString(), finalizedAt: null };
      return route.fulfill({ json: { layout } });
    }
    if (method === "POST" && layout) {
      layout.finalizedAt = new Date().toISOString();
      return route.fulfill({ json: { layout } });
    }
    return route.fulfill({ status: 400, json: { error: "Ongeldige aanvraag" } });
  });
  await page.route("**/api/burn-packages", (route) => route.fulfill({ json: { packages: {
    state: "ready",
    completedTracks: 50,
    totalTracks: 50,
    currentDisc: null,
    currentTrack: null,
    error: null,
    downloads: [
      { id: "cd-1", label: "CD 1 downloaden", url: "/api/burn-packages/cd-1", size: 700_000_000 },
      { id: "cd-2", label: "CD 2 downloaden", url: "/api/burn-packages/cd-2", size: 710_000_000 },
      { id: "cd-3", label: "CD 3 downloaden", url: "/api/burn-packages/cd-3", size: 720_000_000 },
      { id: "all", label: "Alles downloaden", url: "/api/burn-packages/all", size: 2_130_000_000 },
    ],
  } } }));
  await page.goto("/cds");
  await expect(page.locator(".disc-track")).toHaveCount(50);
  await expect(page.locator("#disc-eyebrow")).toHaveText("Conceptindeling");
  if (!isMobile) {
    const listBox = await page.locator(".disc-track-list").first().boundingBox();
    const selectBox = await page.locator(".disc-track-list select").first().boundingBox();
    expect((listBox?.x ?? 0) + (listBox?.width ?? 0) - ((selectBox?.x ?? 0) + (selectBox?.width ?? 0))).toBeGreaterThanOrEqual(10);
  }
  if (isMobile) {
    for (const control of [page.locator(".disc-row-controls button").first(), page.locator(".disc-row-controls select").first()]) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  }
  const firstSelect = page.locator(".disc-track [data-move-select]").first();
  const current = await firstSelect.inputValue();
  await firstSelect.selectOption(current === "0" ? "1" : "0");
  await expect.poll(() => layout?.discs.flat().length).toBe(50);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#finalize-discs").click();
  await expect(page.locator("#disc-eyebrow")).toHaveText("Definitieve indeling");
  await expect(page.locator("#burn-packages")).toBeVisible();
  await expect(page.locator(".burn-download")).toHaveCount(4);
  await expect(page.locator(".burn-download--all")).toContainText("2 GB");
});

test("alle pagina’s houden document-scroll en horizontale overflow tegen", async ({ page }) => {
  await page.route("**/api/voting/*", (route) => route.fulfill({ json: votingPayload() }));
  await page.route("**/api/submissions/*", (route) => route.fulfill({ json: { submission: null } }));
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: {} } }));
  await page.route("**/api/ranking", (route) => route.fulfill({ json: { status: groupStatus(), ranking: null } }));
  await page.route("**/api/disc-layout", (route) => route.fulfill({ json: { status: groupStatus(), layout: null, tracks: [], organizerId: "viktor" } }));
  for (const pathName of ["/stemmen", "/mijn-20", "/ranglijst", "/cds"]) {
    await page.goto(pathName);
    const sizes = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: document.documentElement.clientHeight,
      windowScroll: window.scrollY,
    }));
    expect(sizes.bodyWidth).toBeLessThanOrEqual(sizes.viewportWidth);
    expect(sizes.documentHeight).toBe(sizes.viewportHeight);
    expect(sizes.windowScroll).toBe(0);
  }
});
