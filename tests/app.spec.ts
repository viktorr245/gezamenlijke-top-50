import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { members, type MemberId, type Track } from "../src/data/tracks";
import { authenticatedMember, requireMember, sessionCookie, verifyPin } from "../src/server/auth";
import { finalizeDiscLayout, getDiscLayout, saveDiscLayout } from "../src/server/disc-layout-storage";
import { startPathForPhase } from "../src/server/group-state";
import { listPinnedITunesTracks, pinITunesTrack, searchITunes } from "../src/server/itunes-cache";
import { calculateRanking } from "../src/server/ranking";
import { finalizeSubmission, getSubmission, listSubmissions, saveDraftSubmission, type SubmissionIndex } from "../src/server/submission-storage";
import { buildComparisonSchedules, campaignIdFor, castVote, finalizeVoting, listVotes, loadVotingState, undoLastVote, type VoteChoice } from "../src/server/vote-storage";
import { ZipWriter } from "../src/server/zip-writer";
import { POST as login } from "../src/pages/api/auth/login";
import { POST as logout } from "../src/pages/api/auth/logout";

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

function votingPayload(voteCount = 0, votingDone = false, votingComplete = false) {
  const left = makeTrack("daniel", 0);
  const right = makeTrack("keano", 0);
  return {
    status: groupStatus({ readyForVoting: true, votingComplete, phase: votingComplete ? "ranglijst" : "stemmen", finalizedCount: 5 }),
    member: { memberId: "viktor", trackCount: 20, audioCount: 20, finalized: true, voteCount, votingDone },
    comparison: voteCount < 120 ? { id: `comparison-${voteCount}`, voterId: "viktor", leftId: left.id, rightId: right.id } : null,
    tracks: voteCount < 120 ? { left, right } : null,
    canUndo: voteCount > 0 && !votingDone,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("gezamenlijke-top-50-member")) localStorage.setItem("gezamenlijke-top-50-member", "viktor");
  });
  await page.route("**/api/status", (route) => route.fulfill({ json: { status: groupStatus() } }));
  await page.route("**/api/storage-status?**", (route) => route.fulfill({ json: { storage: {
    usedBytes: 1024 ** 3,
    availableBytes: 10 * 1024 ** 3,
    quotaBytes: 25 * 1024 ** 3,
    remainingBytes: 10 * 1024 ** 3,
    minimumFreeBytes: 512 * 1024 ** 2,
    lastBackupAt: null,
  } } }));
});

test("de startpagina verwijst naar de pagina van de actuele fase", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  expect(startPathForPhase("inzenden")).toBe("/mijn-20");
  expect(startPathForPhase("stemmen")).toBe("/stemmen");
  expect(startPathForPhase("ranglijst")).toBe("/ranglijst");
});

test("pincode-login maakt een ondertekende sessie en schermt andere deelnemers af", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const previousPins = process.env.MEMBER_PINS;
  const previousSecret = process.env.AUTH_SECRET;
  const previousTrustProxy = process.env.TRUST_PROXY;
  const previousPublicOrigin = process.env.PUBLIC_ORIGIN;
  process.env.MEMBER_PINS = JSON.stringify({ viktor: "1111", daniel: "2222", keano: "3333", sander: "4444", jurjan: "5555" });
  process.env.AUTH_SECRET = "een-testgeheim-dat-langer-is-dan-tweeendertig-tekens";
  delete process.env.TRUST_PROXY;
  try {
    expect(verifyPin("daniel", "2222")).toBe("daniel");
    expect(() => verifyPin("daniel", "9999")).toThrow(/Controleer/);
    const loginRequest = new Request("https://voorbeeld.test/api/auth/login");
    const cookie = sessionCookie("daniel", loginRequest).split(";")[0];
    expect(cookie).toContain("gezamenlijke_top_50_session=");
    const forwardedHttpRequest = new Request("http://voorbeeld.test/", { headers: { "X-Forwarded-Proto": "https" } });
    expect(sessionCookie("daniel", forwardedHttpRequest)).not.toContain("; Secure");
    const signedRequest = new Request("https://voorbeeld.test/api/submissions/daniel", { headers: { Cookie: cookie } });
    expect(authenticatedMember(signedRequest)).toBe("daniel");
    expect(requireMember(signedRequest, "daniel")).toBe("daniel");
    expect(() => requireMember(signedRequest, "viktor")).toThrow(/alleen je eigen/);
    const tampered = new Request("https://voorbeeld.test/", { headers: { Cookie: `${cookie}x` } });
    expect(authenticatedMember(tampered)).toBeUndefined();

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const request = new Request("https://voorbeeld.test/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://voorbeeld.test",
          "X-Forwarded-For": `203.0.113.${attempt + 1}`,
        },
        body: JSON.stringify({ memberId: "daniel", pin: "fout" }),
      });
      const response = await login({ request, clientAddress: "198.51.100.20" } as Parameters<typeof login>[0]);
      expect(response.status).toBe(attempt < 8 ? 401 : 429);
    }

    process.env.TRUST_PROXY = "true";
    expect(sessionCookie("daniel", forwardedHttpRequest)).toContain("; Secure");
    const proxiedRequest = new Request("https://voorbeeld.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://voorbeeld.test", "X-Forwarded-For": "203.0.113.200" },
      body: JSON.stringify({ memberId: "daniel", pin: "fout" }),
    });
    expect((await login({ request: proxiedRequest, clientAddress: "198.51.100.20" } as Parameters<typeof login>[0])).status).toBe(401);

    process.env.PUBLIC_ORIGIN = "https://degezamenlijke50.boe.moe";
    const publicProxyRequest = new Request("http://192.168.2.61:4321/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://degezamenlijke50.boe.moe",
        "X-Forwarded-For": "203.0.113.201",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ memberId: "viktor", pin: "1111" }),
    });
    const publicProxyResponse = await login({ request: publicProxyRequest, clientAddress: "192.168.2.64" } as Parameters<typeof login>[0]);
    expect(publicProxyResponse.status).toBe(200);
    expect(publicProxyResponse.headers.get("Set-Cookie")).toContain("; Secure");

    const publicLogoutRequest = new Request("http://192.168.2.61:4321/api/auth/logout", {
      method: "POST",
      headers: { Origin: "https://degezamenlijke50.boe.moe", "X-Forwarded-Proto": "https" },
    });
    const publicLogoutResponse = await logout({ request: publicLogoutRequest } as Parameters<typeof logout>[0]);
    expect(publicLogoutResponse.status).toBe(204);
    expect(publicLogoutResponse.headers.get("Set-Cookie")).toContain("; Secure");

    const foreignLogoutRequest = new Request("http://192.168.2.61:4321/api/auth/logout", {
      method: "POST",
      headers: { Origin: "https://kwaad.example" },
    });
    expect((await logout({ request: foreignLogoutRequest } as Parameters<typeof logout>[0])).status).toBe(403);

    const foreignOriginRequest = new Request("http://192.168.2.61:4321/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://kwaad.example" },
      body: JSON.stringify({ memberId: "viktor", pin: "1111" }),
    });
    expect((await login({ request: foreignOriginRequest, clientAddress: "192.168.2.64" } as Parameters<typeof login>[0])).status).toBe(403);

    const oversizedLoginRequest = new Request("http://192.168.2.61:4321/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://degezamenlijke50.boe.moe" },
      body: JSON.stringify({ memberId: "viktor", pin: "1".repeat(5_000) }),
    });
    expect((await login({ request: oversizedLoginRequest, clientAddress: "192.168.2.64" } as Parameters<typeof login>[0])).status).toBe(413);
  } finally {
    if (previousPins === undefined) delete process.env.MEMBER_PINS;
    else process.env.MEMBER_PINS = previousPins;
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
    if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrustProxy;
    if (previousPublicOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousPublicOrigin;
  }
});

test("opslagstatus meet bestanden, vrije ruimte en de nieuwste back-up", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const directory = await mkdtemp(path.join(tmpdir(), "top50-storage-health-"));
  const backupDirectory = path.join(directory, "backups");
  try {
    await mkdir(backupDirectory);
    await writeFile(path.join(directory, "gegevens.bin"), Buffer.alloc(1024));
    await writeFile(path.join(backupDirectory, "backup.json"), "{}\n");
    const { getStorageHealth } = await import("../src/server/storage-health");
    const health = await getStorageHealth(directory, backupDirectory);
    expect(health.usedBytes).toBeGreaterThanOrEqual(1027);
    expect(health.availableBytes).toBeGreaterThan(0);
    expect(health.remainingBytes).toBeGreaterThan(0);
    expect(health.lastBackupAt).not.toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  expect(() => calculateRanking(tracks, choices, 0)).toThrow(/positief geheel getal/);
});

test("stemmen worden in de vaste volgorde bewaard en kunnen één stap terug", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const directory = await mkdtemp(path.join(tmpdir(), "top50-votes-"));
  const storagePath = path.join(directory, "votes.json");
  const submissions = completeSubmissions();
  const comparison = buildComparisonSchedules(submissions).viktor[0];
  try {
    await castVote(submissions, "viktor", comparison.id, comparison.leftId, storagePath);
    expect(await listVotes(submissions, storagePath)).toMatchObject({ viktor: [{ winnerId: comparison.leftId }] });
    await expect(castVote(submissions, "viktor", comparison.id, comparison.leftId, storagePath)).rejects.toThrow(/niet meer actueel/);
    expect((await undoLastVote(submissions, "viktor", storagePath))?.id).toBe(comparison.id);
    expect((await listVotes(submissions, storagePath)).viktor).toHaveLength(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("120 keuzes worden pas definitief na een aparte bevestiging", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const directory = await mkdtemp(path.join(tmpdir(), "top50-vote-finalization-"));
  const storagePath = path.join(directory, "votes.json");
  const submissions = completeSubmissions();
  const choices: VoteChoice[] = buildComparisonSchedules(submissions).viktor.map((comparison, index) => ({
    ...comparison,
    winnerId: comparison.leftId,
    loserId: comparison.rightId,
    chosenAt: new Date(Date.UTC(2026, 7, 3, 0, 0, index)).toISOString(),
  }));
  try {
    await writeFile(storagePath, JSON.stringify({
      version: 2,
      campaignId: campaignIdFor(submissions),
      choices: { viktor: choices },
      finalizedAt: {},
    }));
    expect((await loadVotingState(submissions, storagePath)).finalizedAt.viktor).toBeUndefined();
    await finalizeVoting(submissions, "viktor", storagePath);
    expect((await loadVotingState(submissions, storagePath)).finalizedAt.viktor).toBeTruthy();
    await expect(undoLastVote(submissions, "viktor", storagePath)).rejects.toThrow(/definitief/);

    await writeFile(storagePath, JSON.stringify({
      version: 1,
      campaignId: campaignIdFor(submissions),
      choices: { viktor: choices },
    }));
    expect((await loadVotingState(submissions, storagePath)).finalizedAt.viktor).toBe(choices[119].chosenAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    const reusedId = { ...makeTrack("daniel", 19), id: viktorTracks[1].id, title: "Andere titel" };
    await expect(saveDraftSubmission("daniel", [reusedId], storagePath)).rejects.toThrow(/nummer-id/);
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

test("handmatige nummers worden veilig bewaard en doen mee aan dubbele-detectie", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const directory = await mkdtemp(path.join(tmpdir(), "top50-manual-submissions-"));
  const storagePath = path.join(directory, "submissions.json");
  const manualTrack: Track = {
    id: "manual-viktor-12345678",
    title: "  Eigen nummer  ",
    artist: "  Onze Band  ",
    album: "  Demo's  ",
    owner: "viktor",
    duration: 222,
    cover: "/covers/handmatig.svg",
    source: "manual",
  };
  try {
    const saved = await saveDraftSubmission("viktor", [manualTrack], storagePath);
    expect(saved.tracks[0]).toMatchObject({
      id: manualTrack.id,
      title: "Eigen nummer",
      artist: "Onze Band",
      album: "Demo's",
      duration: 222,
      source: "manual",
    });

    await expect(saveDraftSubmission("daniel", [{
      ...manualTrack,
      id: "manual-daniel-87654321",
      title: "ÉIGEN nummer!",
      artist: "onze band",
      owner: "daniel",
    }], storagePath)).rejects.toThrow(/al in de lijst/);
    await expect(saveDraftSubmission("daniel", [{
      ...manualTrack,
      id: "manual-viktor-verkeerde-eigenaar",
      owner: "daniel",
    }], storagePath)).rejects.toThrow(/ongeldige gegevens/);
    await expect(saveDraftSubmission("viktor", [{
      ...makeTrack("viktor", 0),
      id: "itunes-12345",
      source: "itunes",
      sourceId: 12345,
    }], storagePath)).rejects.toThrow(/ongeldige gegevens/);
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

test("een cd-indeling telt ook de stiltes tussen nummers mee", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const directory = await mkdtemp(path.join(tmpdir(), "top50-disc-gaps-"));
  const storagePath = path.join(directory, "layout.json");
  const tracks = members.flatMap((member) => Array.from({ length: 10 }, (_, index) => ({ ...makeTrack(member.id, index), duration: 282 })));
  const ids = tracks.map((track) => track.id);
  const discs = [ids.slice(0, 17), ids.slice(17, 34), ids.slice(34)];
  try {
    await saveDiscLayout(discs, ids, storagePath);
    await expect(finalizeDiscLayout(tracks, ids, storagePath)).rejects.toThrow(/langer dan 80 minuten/);
    expect((await getDiscLayout(storagePath))?.finalizedAt).toBeNull();
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

    stored.queries = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`toekomst-${index}`, {
      query: `toekomst ${index}`,
      fetchedAt: "2099-01-01T00:00:00.000Z",
      sourceIds: ["12345"],
    }]));
    await writeFile(cachePath, JSON.stringify(stored));
    expect((await searchITunes("nieuwe zoekopdracht", fetcher, cachePath)).tracks).toHaveLength(1);
    const pruned = JSON.parse(await readFile(cachePath, "utf8"));
    expect(Object.keys(pruned.queries)).toHaveLength(500);
    expect(pruned.queries["nieuwe zoekopdracht"]).toBeTruthy();
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
    expect(record.duration).toBeGreaterThan(0.9);
    expect(record.duration).toBeLessThan(1.1);
    const original = await storage.getAudioAsset("audio-test", true);
    const playback = await storage.getAudioAsset("audio-test");
    expect(original?.mimeType).toBe("audio/wav");
    expect(playback?.mimeType).toBe("audio/webm");
    expect(await readFile(original!.path)).toEqual(wav);

    await storage.saveAudio("audio-test", new File([Uint8Array.from(wav)], "vervanging.wav", { type: "audio/wav" }), {
      title: "Testnummer",
      artist: "Testartiest",
    });
    const replacement = await storage.getAudioAsset("audio-test", true);
    expect(replacement?.path).not.toBe(original?.path);
    await expect(readFile(original!.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(replacement!.path)).toEqual(wav);
    const orphan = path.join(path.dirname(replacement!.path), `achtergebleven-${"a".repeat(32)}.webm`);
    await writeFile(orphan, "oud");
    await storage.saveAudio("audio-tweede", new File([Uint8Array.from(wav)], "tweede.wav", { type: "audio/wav" }), {
      title: "Tweede testnummer",
      artist: "Testartiest",
    });
    await expect(readFile(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await storage.removeAudioBatch(["audio-test", "audio-tweede"])).toBe(2);
    expect(await storage.removeAudioBatch([])).toBe(0);
    expect(await storage.getAudioAsset("audio-test", true)).toBeUndefined();
    expect(await storage.getAudioAsset("audio-tweede", true)).toBeUndefined();
    await expect(readFile(replacement!.path)).rejects.toMatchObject({ code: "ENOENT" });
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

test("een mislukte stem wordt ook visueel teruggedraaid", async ({ page }) => {
  await page.route("**/api/voting/viktor", async (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ status: 500, json: { error: "Opslaan mislukt." } });
    }
    await route.fulfill({ json: votingPayload(7) });
  });

  await page.goto("/stemmen");
  const left = page.locator('[data-choice="left"]');
  const right = page.locator('[data-choice="right"]');
  await left.locator("[data-vote]").click();
  await expect(page.locator("#vote-message")).toHaveText("Opslaan mislukt.");
  await expect(left).not.toHaveClass(/is-selected/);
  await expect(right).not.toHaveClass(/is-rejected/);
  await expect(left.locator("[data-vote]")).toBeEnabled();
});

test("snel wisselen tussen nummers laat alleen de laatste stemkaart afspelen", async ({ page }) => {
  await page.addInitScript(() => {
    class DelayedAudio extends EventTarget {
      src = "";
      paused = true;
      currentTime = 0;
      duration = 180;
      volume = 1;
      load() {}
      pause() { this.paused = true; }
      removeAttribute(name: string) { if (name === "src") this.src = ""; }
      play() {
        const delay = this.src.includes("daniel") ? 80 : 0;
        return new Promise<void>((resolve) => window.setTimeout(() => {
          this.paused = false;
          resolve();
        }, delay));
      }
    }
    Object.defineProperty(window, "Audio", { configurable: true, value: DelayedAudio });
  });
  await page.route("**/api/voting/viktor", (route) => route.fulfill({ json: votingPayload(7) }));

  await page.goto("/stemmen");
  const left = page.locator('[data-choice="left"]');
  const right = page.locator('[data-choice="right"]');
  await left.locator("[data-play]").click();
  await right.locator("[data-play]").click();
  await page.waitForTimeout(120);
  await expect(left).not.toHaveClass(/is-playing/);
  await expect(right).toHaveClass(/is-playing/);
});

test("na keuze 120 volgt eerst een expliciete definitieve bevestiging", async ({ page }) => {
  let voteCount = 120;
  let finalized = false;
  let finalizeRequests = 0;
  await page.route("**/api/voting/viktor", async (route) => {
    if (route.request().method() === "DELETE") voteCount -= 1;
    if (route.request().method() === "POST") voteCount += 1;
    if (route.request().method() === "PUT") {
      finalized = true;
      finalizeRequests += 1;
    }
    await route.fulfill({ json: votingPayload(voteCount, finalized) });
  });

  await page.goto("/stemmen");
  await expect(page.getByRole("heading", { name: "Je hebt alle 120 keuzes gemaakt." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mijn stemmen definitief maken" })).toBeVisible();
  await page.getByRole("button", { name: "Laatste keuze aanpassen" }).click();
  await expect(page.locator("#vote-count")).toHaveText("119");
  await expect(page.locator("#vote-grid")).toBeVisible();

  await page.locator('[data-choice="left"] [data-vote]').click();
  await expect(page.getByRole("heading", { name: "Je hebt alle 120 keuzes gemaakt." })).toBeVisible();
  await page.getByRole("button", { name: "Mijn stemmen definitief maken" }).click();
  await expect(page.getByRole("heading", { name: "Jouw stemmen staan vast." })).toBeVisible();
  expect(finalizeRequests).toBe(1);
});

test("Mijn 20 zoekt, bewaart centraal en maakt audio duidelijk verplicht", async ({ page, isMobile }) => {
  let draft: Track[] = [];
  let audioUploads = 0;
  await page.route("**/api/submissions/viktor", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { submission: null } });
    const body = route.request().postDataJSON() as { tracks: Track[] };
    draft = body.tracks;
    await route.fulfill({ json: { submission: { memberId: "viktor", tracks: draft, updatedAt: new Date().toISOString(), finalizedAt: null } } });
  });
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: {} } }));
  const result = { ...makeTrack("viktor", 0), id: "itunes-100000", source: "itunes" as const, sourceId: "100000", previewUrl: "https://example.test/preview.m4a" };
  await page.route(`**/api/audio/${result.id}`, async (route) => {
    audioUploads += 1;
    await route.fulfill({ json: { audio: {
      trackId: result.id,
      title: result.title,
      artist: result.artist,
      originalName: "gesleept-nummer.wav",
      mimeType: "audio/webm",
      size: 1234,
      duration: 180,
      uploadedAt: new Date().toISOString(),
      url: `/api/audio/${result.id}`,
    } } });
  });
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

  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["testaudio"], "gesleept-nummer.wav", { type: "audio/wav" }));
    return transfer;
  });
  const dropzone = page.locator("[data-audio-drop]");
  await dropzone.dispatchEvent("dragenter", { dataTransfer });
  await dropzone.dispatchEvent("dragover", { dataTransfer });
  await expect(dropzone).toHaveClass(/is-drag-over/);
  await expect(dropzone.locator(".audio-drop-release")).toBeVisible();
  await dropzone.dispatchEvent("drop", { dataTransfer });
  await expect(page.locator(".audio-ready-label")).toContainText("Audio toegevoegd");
  expect(audioUploads).toBe(1);
});

test("Mijn 20 kan na een tijdelijke laadfout opnieuw proberen", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/submissions/viktor", async (route) => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 500, json: { error: "Laden mislukt." } });
    return route.fulfill({ json: { submission: null } });
  });
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: {} } }));

  await page.goto("/mijn-20");
  await expect(page.locator("#retry-submission-load")).toBeVisible();
  await expect(page.locator("#track-search")).toBeDisabled();
  await page.locator("#retry-submission-load").click();
  await expect(page.locator("#retry-submission-load")).toBeHidden();
  await expect(page.locator("#track-search")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("snel wisselen in Mijn 20 houdt alleen het laatste nummer actief", async ({ page }) => {
  await page.addInitScript(() => {
    class DelayedAudio extends EventTarget {
      src = "";
      paused = true;
      currentTime = 0;
      duration = 180;
      volume = 1;
      load() {}
      pause() { this.paused = true; }
      removeAttribute(name: string) { if (name === "src") this.src = ""; }
      play() {
        const delay = this.src.includes("viktor-00") ? 80 : 0;
        return new Promise<void>((resolve) => window.setTimeout(() => {
          this.paused = false;
          resolve();
        }, delay));
      }
    }
    Object.defineProperty(window, "Audio", { configurable: true, value: DelayedAudio });
  });
  const tracks = [makeTrack("viktor", 0), makeTrack("viktor", 1)];
  await page.route("**/api/submissions/viktor", (route) => route.fulfill({ json: { submission: {
    memberId: "viktor",
    tracks,
    updatedAt: "2026-08-03T12:00:00.000Z",
    finalizedAt: null,
  } } }));
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: Object.fromEntries(tracks.map((track) => [track.id, {
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    originalName: `${track.id}.wav`,
    mimeType: "audio/webm",
    size: 1234,
    duration: 180,
    uploadedAt: "2026-08-03T12:00:00.000Z",
    url: `/api/audio/${track.id}`,
  }])) } }));

  await page.goto("/mijn-20");
  const rows = page.locator(".submission-row");
  await rows.nth(0).locator("[data-cover-play]").click();
  await rows.nth(1).locator("[data-cover-play]").click();
  await page.waitForTimeout(120);
  await expect(rows.nth(0)).not.toHaveClass(/is-audio-playing/);
  await expect(rows.nth(1)).toHaveClass(/is-audio-playing/);
});

test("Mijn 20 laat een niet-gevonden nummer handmatig en zonder iTunes-verzoek toevoegen", async ({ page, isMobile }) => {
  let draft: Track[] = [];
  let catalogRequests = 0;
  await page.route("**/api/submissions/viktor", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { submission: null } });
    draft = (route.request().postDataJSON() as { tracks: Track[] }).tracks;
    return route.fulfill({ json: { submission: { memberId: "viktor", tracks: draft, updatedAt: new Date().toISOString(), finalizedAt: null } } });
  });
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: {} } }));
  await page.route(/\/api\/audio\/manual-viktor-/, (route) => {
    const trackId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    return route.fulfill({ json: { audio: {
      trackId,
      title: "Eigen Nummer",
      artist: "Onze Band",
      originalName: "eigen-nummer.wav",
      mimeType: "audio/webm",
      size: 1234,
      duration: 222,
      uploadedAt: new Date().toISOString(),
      url: `/api/audio/${trackId}`,
    } } });
  });
  await page.route("**/api/itunes/catalog", (route) => {
    catalogRequests += 1;
    return route.fulfill({ status: 500, json: { error: "Onverwacht iTunes-verzoek" } });
  });

  await page.goto("/mijn-20");
  const openButton = page.getByRole("button", { name: /Handmatig toevoegen/ });
  await expect(openButton).toBeEnabled();
  if (isMobile) {
    const box = await openButton.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(32);
  }
  await openButton.click();
  const dialog = page.getByRole("dialog", { name: "Staat je nummer niet in iTunes?" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Nummer toevoegen" }).click();
  await expect(page.locator("#manual-track-error")).toHaveText("Vul de titel van het nummer in.");
  await page.locator("#manual-title").fill("Eigen Nummer");
  await page.locator("#manual-artist").fill("Onze Band");
  await page.locator("#manual-album").fill("Eerste Demo");
  await expect(page.locator("#manual-duration")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Nummer toevoegen" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".submission-row")).toHaveCount(1);
  await expect(page.locator(".submission-row .row-track")).toContainText("Eigen Nummer");
  await expect(page.locator(".submission-row .row-track")).toContainText("Onze Band");
  await expect(page.locator(".submission-row .row-duration")).toHaveText("—");
  await expect(page.locator(".audio-required")).toContainText("Audio ontbreekt");
  await expect(page.locator(".row-cover-button")).toBeDisabled();
  await expect.poll(() => draft.length).toBe(1);
  expect(draft[0]).toMatchObject({
    title: "Eigen Nummer",
    artist: "Onze Band",
    album: "Eerste Demo",
    duration: 0,
    cover: "/covers/handmatig.svg",
    source: "manual",
  });
  expect(draft[0].id).toMatch(/^manual-viktor-[a-f0-9-]{36}$/);
  expect(catalogRequests).toBe(0);

  await page.locator("[data-audio-file]").setInputFiles({
    name: "eigen-nummer.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("testaudio"),
  });
  await expect(page.locator(".audio-ready-label")).toContainText("Audio toegevoegd");
  await expect(page.locator(".submission-row .row-duration")).toHaveText("3:42");
  await expect(page.locator(".row-cover-button")).toBeEnabled();
});

test("een nummer verwijderen wordt met één consistente conceptupdate opgeslagen", async ({ page }) => {
  const track = { ...makeTrack("viktor", 0), id: "itunes-100000", source: "itunes" as const, sourceId: "100000" };
  let draft = [track];
  let audioDeleteRequested = false;
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
    audioDeleteRequested = route.request().method() === "DELETE";
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/mijn-20");
  await expect(page.locator(".audio-ready-label")).toContainText("Audio toegevoegd");
  await page.locator(".remove-track").click();
  await expect(page.locator(".submission-row")).toHaveCount(0);
  await expect.poll(() => draft.length).toBe(0);
  expect(audioDeleteRequested).toBe(false);
});

test("een mislukte conceptupdate laat nummer en audio in Mijn 20 staan", async ({ page }) => {
  const track = { ...makeTrack("viktor", 0), id: "itunes-100000", source: "itunes" as const, sourceId: "100000" };
  await page.route("**/api/submissions/viktor", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { submission: { memberId: "viktor", tracks: [track], updatedAt: new Date().toISOString(), finalizedAt: null } } });
    }
    return route.fulfill({ status: 500, json: { error: "Concept opslaan mislukt." } });
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

  await page.goto("/mijn-20");
  await page.locator(".remove-track").click();
  await expect(page.locator("#submission-message")).toHaveText("Concept opslaan mislukt.");
  await expect(page.locator(".submission-row")).toHaveCount(1);
  await expect(page.locator(".audio-ready-label")).toContainText("Audio toegevoegd");
});

test("Mijn 20 verwerkt lijstwijzigingen strikt na elkaar", async ({ page }) => {
  const tracks = [makeTrack("viktor", 0), makeTrack("viktor", 1)];
  let storedTracks = [...tracks];
  let putCount = 0;
  let releaseFirstSave!: () => void;
  const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
  await page.route("**/api/submissions/viktor", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { submission: { memberId: "viktor", tracks: storedTracks, updatedAt: new Date().toISOString(), finalizedAt: null } } });
    }
    putCount += 1;
    if (putCount === 1) await firstSaveGate;
    storedTracks = (route.request().postDataJSON() as { tracks: Track[] }).tracks;
    return route.fulfill({ json: { submission: { memberId: "viktor", tracks: storedTracks, updatedAt: new Date().toISOString(), finalizedAt: null } } });
  });
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: {} } }));

  await page.goto("/mijn-20");
  await page.locator(".remove-track").first().click();
  await expect.poll(() => putCount).toBe(1);
  await expect(page.locator(".remove-track").nth(1)).toBeDisabled();
  releaseFirstSave();
  await expect(page.locator(".submission-row")).toHaveCount(1);
  await page.locator(".remove-track").click();
  await expect(page.locator(".submission-row")).toHaveCount(0);
  await expect.poll(() => storedTracks.length).toBe(0);
  expect(putCount).toBe(2);
});

test("Mijn 20 blokkeert andere wijzigingen tijdens definitief maken", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const tracks = Array.from({ length: 20 }, (_, index) => makeTrack("viktor", index));
  let finalizeStarted = false;
  let releaseFinalize!: () => void;
  const finalizeGate = new Promise<void>((resolve) => { releaseFinalize = resolve; });
  await page.route("**/api/submissions/viktor", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { submission: { memberId: "viktor", tracks, updatedAt: new Date().toISOString(), finalizedAt: null } } });
    }
    if (route.request().method() === "POST") {
      finalizeStarted = true;
      await finalizeGate;
      return route.fulfill({ status: 201, json: { submission: {
        memberId: "viktor",
        tracks,
        updatedAt: "2026-08-03T12:00:00.000Z",
        finalizedAt: "2026-08-03T12:00:00.000Z",
      } } });
    }
    return route.fulfill({ json: { submission: { memberId: "viktor", tracks, updatedAt: new Date().toISOString(), finalizedAt: null } } });
  });
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: Object.fromEntries(tracks.map((track) => [track.id, {
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    originalName: `${track.id}.wav`,
    mimeType: "audio/webm",
    size: 1234,
    duration: track.duration,
    uploadedAt: "2026-08-03T12:00:00.000Z",
    url: `/api/audio/${track.id}`,
  }])) } }));

  await page.goto("/mijn-20");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#save-submission").click();
  await expect.poll(() => finalizeStarted).toBe(true);
  await expect(page.locator(".remove-track").first()).toBeDisabled();
  await expect(page.locator(".audio-replace-action").first()).toBeDisabled();
  await expect(page.locator("#save-submission")).toHaveText("Definitief maken…");
  releaseFinalize();
  await expect(page.locator("#save-submission")).toBeHidden();
});

test("audio van een definitieve inzending kan in de interface niet worden vervangen", async ({ page }) => {
  const track = { ...makeTrack("viktor", 0), id: "itunes-100000", source: "itunes" as const, sourceId: "100000" };
  await page.route("**/api/submissions/viktor", (route) => route.fulfill({ json: { submission: {
    memberId: "viktor",
    tracks: [track],
    updatedAt: "2026-08-03T12:00:00.000Z",
    finalizedAt: "2026-08-03T12:00:00.000Z",
  } } }));
  await page.route("**/api/audio", (route) => route.fulfill({ json: { audio: {
    [track.id]: {
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      originalName: "origineel.flac",
      mimeType: "audio/webm",
      size: 1234,
      uploadedAt: "2026-08-03T12:00:00.000Z",
      url: `/api/audio/${track.id}`,
    },
  } } }));

  await page.goto("/mijn-20");
  await expect(page.locator(".submission-row")).toHaveCount(1);
  await expect(page.locator("[data-row-play]")).toBeVisible();
  await expect(page.locator("[data-upload-audio], [data-audio-file], [data-audio-drop]")).toHaveCount(0);
  await expect(page.locator("#add-track-form")).toBeHidden();
  await expect(page.locator("#save-submission")).toBeHidden();
  await expect(page.locator(".remove-track")).toHaveCount(0);
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
  await expect(page.locator("#storage-card")).toBeVisible();
  await page.locator("#storage-card summary").click();
  await expect(page.locator("#storage-used")).toHaveText("1 GB");
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

test("een mislukte cd-save kan geen oudere indeling definitief maken", async ({ page }) => {
  const topTracks = members.flatMap((member) => Array.from({ length: 10 }, (_, index) => makeTrack(member.id, index)));
  const ids = topTracks.map((track) => track.id);
  const layout = {
    discs: [ids.slice(0, 17), ids.slice(17, 34), ids.slice(34)],
    topTrackIds: ids,
    updatedAt: "2026-08-03T12:00:00.000Z",
    finalizedAt: null,
  };
  const status = groupStatus({ votingComplete: true, completedVoterCount: 5, finalizedCount: 5, phase: "ranglijst" });
  let finalizeRequests = 0;
  let saveAttempts = 0;
  await page.route("**/api/disc-layout", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { status, layout, tracks: topTracks, organizerId: "viktor" } });
    if (route.request().method() === "PUT") {
      saveAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (saveAttempts === 1) return route.fulfill({ status: 500, json: { error: "Opslaan mislukt." } });
      return route.fulfill({ json: { layout: { ...layout, discs: (route.request().postDataJSON() as { discs: string[][] }).discs } } });
    }
    finalizeRequests += 1;
    return route.fulfill({ json: { layout: { ...layout, finalizedAt: new Date().toISOString() } } });
  });

  await page.goto("/cds");
  const select = page.locator(".disc-track [data-move-select]").first();
  await select.selectOption("1");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#finalize-discs").click();
  await expect(page.locator("#disc-message")).toContainText("Opslaan mislukt.");
  expect(finalizeRequests).toBe(0);
  await expect(page.locator("#disc-eyebrow")).toHaveText("Conceptindeling");
  await page.locator("#retry-layout-save").click();
  await expect(page.locator("#retry-layout-save")).toBeHidden();
  await expect(page.locator("#disc-message")).toBeEmpty();
  await expect(page.locator("#finalize-discs")).toBeEnabled();
  expect(saveAttempts).toBe(2);
});

test("lange paginatitels blijven op een scherm van 320 pixels volledig zichtbaar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route("**/api/ranking", (route) => route.fulfill({ json: { status: groupStatus(), ranking: null } }));
  await page.route("**/api/disc-layout", (route) => route.fulfill({ json: { status: groupStatus(), layout: null, tracks: [], organizerId: "viktor" } }));

  for (const [pathName, selector] of [["/ranglijst", "#ranking-title"], ["/cds", "#discs-title"]] as const) {
    await page.goto(pathName);
    const bounds = await page.locator(selector).evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, viewport: document.documentElement.clientWidth };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
  }
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
