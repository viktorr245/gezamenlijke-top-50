import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMemberId, members, type MemberId, type Track } from "../data/tracks";
import type { SubmissionIndex } from "./submission-storage";

const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR ?? process.env.AUDIO_STORAGE_DIR ?? path.join(process.cwd(), "storage"));
const DEFAULT_STORAGE_PATH = path.join(STORAGE_ROOT, "votes.json");

export type Comparison = {
  id: string;
  voterId: MemberId;
  leftId: string;
  rightId: string;
};

export type VoteChoice = Comparison & {
  winnerId: string;
  loserId: string;
  chosenAt: string;
};

type VoteDocument = {
  version: 1;
  campaignId: string;
  choices: Partial<Record<MemberId, VoteChoice[]>>;
};

const writeQueues = new Map<string, Promise<void>>();

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function campaignIdFor(submissions: Partial<SubmissionIndex>): string {
  const fingerprint = members.map((member) => {
    const submission = submissions[member.id];
    return `${member.id}:${submission?.finalizedAt ?? "-"}:${(submission?.tracks ?? []).map((track) => track.id).sort().join(",")}`;
  }).join("|");
  return hash(fingerprint).slice(0, 24);
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(hash(seed).slice(0, 8), 16) || 1;
  return () => {
    state |= 0;
    state = state + 0x6d2b79f5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle<T>(values: T[], seed: string): T[] {
  const random = seededRandom(seed);
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function arrangeWithoutImmediateRepeats(edges: Comparison[], seed: string): Comparison[] {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const remaining = shuffle(edges, `${seed}:${attempt}`);
    const result: Comparison[] = [];
    while (remaining.length > 0) {
      const previous = result.at(-1);
      const compatible = previous
        ? remaining.map((edge, index) => ({ edge, index })).filter(({ edge }) =>
          edge.leftId !== previous.leftId
          && edge.leftId !== previous.rightId
          && edge.rightId !== previous.leftId
          && edge.rightId !== previous.rightId)
        : remaining.map((edge, index) => ({ edge, index }));
      if (compatible.length === 0) break;
      // Kies vroeg de koppels met de meeste resterende conflicten. Dat voorkomt
      // dat aan het eind alleen twee opeenvolgende koppels met hetzelfde nummer overblijven.
      const scored = compatible.map((candidate) => ({
        ...candidate,
        conflicts: remaining.filter((edge) =>
          edge.leftId === candidate.edge.leftId
          || edge.leftId === candidate.edge.rightId
          || edge.rightId === candidate.edge.leftId
          || edge.rightId === candidate.edge.rightId).length,
      })).sort((a, b) => b.conflicts - a.conflicts || a.index - b.index);
      result.push(remaining.splice(scored[0].index, 1)[0]);
    }
    if (result.length === edges.length) return result;
  }
  throw new Error("Het vergelijkingsschema kon niet zonder directe herhalingen worden geordend.");
}

export function buildComparisonSchedules(submissions: Partial<SubmissionIndex>): Record<MemberId, Comparison[]> {
  const campaignId = campaignIdFor(submissions);
  const tracksByOwner = Object.fromEntries(members.map((member) => {
    const submission = submissions[member.id];
    if (!submission?.finalizedAt || submission.tracks.length !== 20) throw new Error("Alle vijf inzendingen moeten eerst definitief zijn.");
    return [member.id, [...submission.tracks].sort((a, b) => a.id.localeCompare(b.id))];
  })) as Record<MemberId, Track[]>;

  const raw: Comparison[] = [];
  for (let first = 0; first < members.length; first += 1) {
    for (let second = first + 1; second < members.length; second += 1) {
      const firstOwner = members[first].id;
      const secondOwner = members[second].id;
      const neutralVoters = members.filter((member) => member.id !== firstOwner && member.id !== secondOwner);
      neutralVoters.forEach((voter, shift) => {
        for (let index = 0; index < 20; index += 1) {
          const firstTrack = tracksByOwner[firstOwner][index];
          const secondTrack = tracksByOwner[secondOwner][(index + shift) % 20];
          raw.push({
            id: hash(`${campaignId}:${voter.id}:${firstTrack.id}:${secondTrack.id}`).slice(0, 20),
            voterId: voter.id,
            leftId: firstTrack.id,
            rightId: secondTrack.id,
          });
        }
      });
    }
  }

  // De globale graaf heeft voor ieder nummer graad 12. Een Euler-oriëntatie
  // verdeelt elk nummer daarom exact zes keer links en zes keer rechts.
  const adjacency = new Map<string, Array<{ edgeIndex: number; other: string }>>();
  raw.forEach((edge, edgeIndex) => {
    adjacency.set(edge.leftId, [...(adjacency.get(edge.leftId) ?? []), { edgeIndex, other: edge.rightId }]);
    adjacency.set(edge.rightId, [...(adjacency.get(edge.rightId) ?? []), { edgeIndex, other: edge.leftId }]);
  });
  const used = new Set<number>();
  const pointers = new Map<string, number>();
  for (const start of adjacency.keys()) {
    const stack = [start];
    while (stack.length > 0) {
      const vertex = stack.at(-1)!;
      const edges = adjacency.get(vertex) ?? [];
      let pointer = pointers.get(vertex) ?? 0;
      while (pointer < edges.length && used.has(edges[pointer].edgeIndex)) pointer += 1;
      pointers.set(vertex, pointer);
      if (pointer >= edges.length) {
        stack.pop();
        continue;
      }
      const next = edges[pointer];
      used.add(next.edgeIndex);
      const edge = raw[next.edgeIndex];
      edge.leftId = vertex;
      edge.rightId = next.other;
      stack.push(next.other);
    }
  }

  return Object.fromEntries(members.map((member) => {
    const schedule = raw.filter((edge) => edge.voterId === member.id);
    if (schedule.length !== 120) throw new Error("Het vergelijkingsschema kon niet correct worden opgebouwd.");
    return [member.id, arrangeWithoutImmediateRepeats(schedule, `${campaignId}:${member.id}`)];
  })) as Record<MemberId, Comparison[]>;
}

function safeChoice(value: unknown): VoteChoice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<VoteChoice>;
  if (!candidate.id || !isMemberId(candidate.voterId) || !candidate.leftId || !candidate.rightId) return undefined;
  if (candidate.winnerId !== candidate.leftId && candidate.winnerId !== candidate.rightId) return undefined;
  const loserId = candidate.winnerId === candidate.leftId ? candidate.rightId : candidate.leftId;
  if (candidate.loserId !== loserId || typeof candidate.chosenAt !== "string") return undefined;
  return candidate as VoteChoice;
}

async function readDocument(campaignId: string, storagePath: string): Promise<VoteDocument> {
  try {
    const parsed = JSON.parse(await readFile(storagePath, "utf8")) as Partial<VoteDocument>;
    if (parsed.version !== 1 || parsed.campaignId !== campaignId || !parsed.choices || typeof parsed.choices !== "object") {
      return { version: 1, campaignId, choices: {} };
    }
    const choices: VoteDocument["choices"] = {};
    for (const member of members) {
      const values = parsed.choices[member.id];
      if (Array.isArray(values)) choices[member.id] = values.map(safeChoice).filter((choice): choice is VoteChoice => Boolean(choice));
    }
    return { version: 1, campaignId, choices };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, campaignId, choices: {} };
    throw error;
  }
}

async function writeDocument(storagePath: string, document: VoteDocument) {
  const directory = path.dirname(storagePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.votes-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await rename(temporaryPath, storagePath);
}

function enqueue<T>(storagePath: string, operation: () => Promise<T>): Promise<T> {
  const queue = writeQueues.get(storagePath) ?? Promise.resolve();
  const result = queue.then(operation, operation);
  writeQueues.set(storagePath, result.then(() => undefined, () => undefined));
  return result;
}

function validChoicePrefix(choices: VoteChoice[], schedule: Comparison[]): VoteChoice[] {
  const result: VoteChoice[] = [];
  for (let index = 0; index < choices.length; index += 1) {
    const choice = choices[index];
    const expected = schedule[index];
    if (!expected
      || choice.id !== expected.id
      || choice.voterId !== expected.voterId
      || choice.leftId !== expected.leftId
      || choice.rightId !== expected.rightId) break;
    result.push(choice);
  }
  return result;
}

export async function listVotes(submissions: Partial<SubmissionIndex>, storagePath = DEFAULT_STORAGE_PATH): Promise<VoteDocument["choices"]> {
  const document = await readDocument(campaignIdFor(submissions), storagePath);
  const schedules = buildComparisonSchedules(submissions);
  return Object.fromEntries(members.map((member) => [
    member.id,
    validChoicePrefix(document.choices[member.id] ?? [], schedules[member.id]),
  ])) as VoteDocument["choices"];
}

export async function castVote(
  submissions: Partial<SubmissionIndex>,
  memberIdValue: string,
  comparisonId: string,
  winnerId: string,
  storagePath = DEFAULT_STORAGE_PATH,
): Promise<VoteChoice> {
  if (!isMemberId(memberIdValue)) throw new Error("Onbekende deelnemer.");
  const memberId = memberIdValue;
  const schedules = buildComparisonSchedules(submissions);
  const campaignId = campaignIdFor(submissions);
  return enqueue(storagePath, async () => {
    const document = await readDocument(campaignId, storagePath);
    const choices = validChoicePrefix(document.choices[memberId] ?? [], schedules[memberId]);
    const comparison = schedules[memberId][choices.length];
    if (!comparison) throw new Error("Je hebt alle vergelijkingen al afgerond.");
    if (comparison.id !== comparisonId) throw new Error("Deze vergelijking is niet meer actueel. Vernieuw de pagina.");
    if (winnerId !== comparison.leftId && winnerId !== comparison.rightId) throw new Error("Ongeldige keuze.");
    const choice: VoteChoice = {
      ...comparison,
      winnerId,
      loserId: winnerId === comparison.leftId ? comparison.rightId : comparison.leftId,
      chosenAt: new Date().toISOString(),
    };
    choices.push(choice);
    document.choices[memberId] = choices;
    await writeDocument(storagePath, document);
    return choice;
  });
}

export async function undoLastVote(
  submissions: Partial<SubmissionIndex>,
  memberIdValue: string,
  storagePath = DEFAULT_STORAGE_PATH,
): Promise<VoteChoice | undefined> {
  if (!isMemberId(memberIdValue)) throw new Error("Onbekende deelnemer.");
  const memberId = memberIdValue;
  const campaignId = campaignIdFor(submissions);
  const schedules = buildComparisonSchedules(submissions);
  return enqueue(storagePath, async () => {
    const document = await readDocument(campaignId, storagePath);
    const everyoneDone = members.every((member) => validChoicePrefix(document.choices[member.id] ?? [], schedules[member.id]).length === 120);
    if (everyoneDone) throw new Error("De eindranglijst staat vast; stemmen kunnen niet meer worden gewijzigd.");
    const choices = validChoicePrefix(document.choices[memberId] ?? [], schedules[memberId]);
    const removed = choices.pop();
    document.choices[memberId] = choices;
    await writeDocument(storagePath, document);
    return removed;
  });
}
