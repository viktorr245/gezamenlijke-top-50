import { createHash } from "node:crypto";
import type { Track } from "../data/tracks";
import type { VoteChoice } from "./vote-storage";

export type RankedTrack = Track & {
  rank: number;
  selected: boolean;
  strength: number;
  top50Probability: number;
  expectedRank: number;
  rankLow: number;
  rankHigh: number;
  winRate: number;
  leaveOneOutSelections: number;
};

type IndexedChoice = { winner: number; loser: number; voterId: string };

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function cholesky(matrix: number[][]): number[][] {
  const size = matrix.length;
  const lower = Array.from({ length: size }, () => Array(size).fill(0));
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = matrix[row][column];
      for (let inner = 0; inner < column; inner += 1) value -= lower[row][inner] * lower[column][inner];
      if (row === column) lower[row][column] = Math.sqrt(Math.max(value, 1e-10));
      else lower[row][column] = value / lower[column][column];
    }
  }
  return lower;
}

function solveFromCholesky(lower: number[][], vector: number[]): number[] {
  const size = vector.length;
  const forward = Array(size).fill(0);
  for (let row = 0; row < size; row += 1) {
    let value = vector[row];
    for (let column = 0; column < row; column += 1) value -= lower[row][column] * forward[column];
    forward[row] = value / lower[row][row];
  }
  const result = Array(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = forward[row];
    for (let column = row + 1; column < size; column += 1) value -= lower[column][row] * result[column];
    result[row] = value / lower[row][row];
  }
  return result;
}

function posterior(tracks: Track[], choices: IndexedChoice[], initial?: number[]) {
  const size = tracks.length;
  const precision = 0.25;
  const theta = initial ? [...initial] : Array(size).fill(0);
  let hessian = Array.from({ length: size }, () => Array(size).fill(0));
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const gradient = theta.map((value) => precision * value);
    hessian = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? precision : 0));
    for (const choice of choices) {
      const probability = sigmoid(theta[choice.winner] - theta[choice.loser]);
      const residual = probability - 1;
      const weight = Math.max(probability * (1 - probability), 1e-7);
      gradient[choice.winner] += residual;
      gradient[choice.loser] -= residual;
      hessian[choice.winner][choice.winner] += weight;
      hessian[choice.loser][choice.loser] += weight;
      hessian[choice.winner][choice.loser] -= weight;
      hessian[choice.loser][choice.winner] -= weight;
    }
    const step = solveFromCholesky(cholesky(hessian), gradient);
    const maxStep = Math.max(...step.map(Math.abs));
    for (let index = 0; index < size; index += 1) theta[index] -= step[index];
    if (maxStep < 1e-8) break;
  }
  // De Hessiaan hoort bij het optimum; bouw hem na de laatste stap nog eenmaal op.
  hessian = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? precision : 0));
  for (const choice of choices) {
    const probability = sigmoid(theta[choice.winner] - theta[choice.loser]);
    const weight = Math.max(probability * (1 - probability), 1e-7);
    hessian[choice.winner][choice.winner] += weight;
    hessian[choice.loser][choice.loser] += weight;
    hessian[choice.winner][choice.loser] -= weight;
    hessian[choice.loser][choice.winner] -= weight;
  }
  return { theta, hessian };
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) || 1;
  return () => {
    state |= 0;
    state = state + 0x6d2b79f5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return Math.max(((value ^ value >>> 14) >>> 0) / 4294967296, Number.EPSILON);
  };
}

function normalGenerator(seed: string): () => number {
  const random = seededRandom(seed);
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }
    const first = random();
    const second = random();
    const radius = Math.sqrt(-2 * Math.log(first));
    spare = radius * Math.sin(2 * Math.PI * second);
    return radius * Math.cos(2 * Math.PI * second);
  };
}

function selectedIndices(theta: number[], count = 50): Set<number> {
  return new Set(theta.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value || a.index - b.index).slice(0, count).map((item) => item.index));
}

export function calculateRanking(tracksValue: Track[], rawChoices: VoteChoice[], samples = 2000): RankedTrack[] {
  const tracks = [...tracksValue].sort((a, b) => a.id.localeCompare(b.id));
  if (tracks.length !== 100) throw new Error("De ranglijst vereist precies honderd nummers.");
  const indexById = new Map(tracks.map((track, index) => [track.id, index]));
  const choices: IndexedChoice[] = rawChoices.map((choice) => ({
    winner: indexById.get(choice.winnerId) ?? -1,
    loser: indexById.get(choice.loserId) ?? -1,
    voterId: choice.voterId,
  })).filter((choice) => choice.winner >= 0 && choice.loser >= 0);
  if (choices.length !== 600) throw new Error("De eindranglijst is beschikbaar zodra alle zeshonderd keuzes zijn gemaakt.");

  const { theta, hessian } = posterior(tracks, choices);
  const lower = cholesky(hessian);
  const choiceSeed = rawChoices.map((choice) => `${choice.id}:${choice.winnerId}`).sort().join("|");
  const normal = normalGenerator(choiceSeed);
  const topCounts = Array(tracks.length).fill(0);
  const ranks = Array.from({ length: tracks.length }, () => [] as number[]);
  for (let sample = 0; sample < samples; sample += 1) {
    const z = Array.from({ length: tracks.length }, () => normal());
    const noise = Array(tracks.length).fill(0);
    for (let row = tracks.length - 1; row >= 0; row -= 1) {
      let value = z[row];
      for (let column = row + 1; column < tracks.length; column += 1) value -= lower[column][row] * noise[column];
      noise[row] = value / lower[row][row];
    }
    const order = theta.map((value, index) => ({ index, value: value + noise[index] }))
      .sort((a, b) => b.value - a.value || a.index - b.index);
    order.forEach((item, rank) => {
      ranks[item.index].push(rank + 1);
      if (rank < 50) topCounts[item.index] += 1;
    });
  }

  const wins = Array(tracks.length).fill(0);
  const games = Array(tracks.length).fill(0);
  for (const choice of choices) {
    wins[choice.winner] += 1;
    games[choice.winner] += 1;
    games[choice.loser] += 1;
  }
  const voters = [...new Set(choices.map((choice) => choice.voterId))];
  const leaveOneOut = voters.map((voter) => selectedIndices(posterior(tracks, choices.filter((choice) => choice.voterId !== voter), theta).theta));
  const metrics = tracks.map((track, index) => {
    const sortedRanks = ranks[index].sort((a, b) => a - b);
    const expectedRank = sortedRanks.reduce((sum, rank) => sum + rank, 0) / sortedRanks.length;
    return {
      track,
      index,
      strength: theta[index],
      top50Probability: topCounts[index] / samples,
      expectedRank,
      rankLow: sortedRanks[Math.floor(samples * 0.05)],
      rankHigh: sortedRanks[Math.min(samples - 1, Math.floor(samples * 0.95))],
      winRate: games[index] ? wins[index] / games[index] : 0,
      leaveOneOutSelections: leaveOneOut.filter((selection) => selection.has(index)).length,
    };
  });
  metrics.sort((a, b) =>
    b.top50Probability - a.top50Probability
    || a.expectedRank - b.expectedRank
    || b.strength - a.strength
    || a.track.id.localeCompare(b.track.id),
  );
  return metrics.map((item, index) => ({
    ...item.track,
    rank: index + 1,
    selected: index < 50,
    strength: item.strength,
    top50Probability: item.top50Probability,
    expectedRank: item.expectedRank,
    rankLow: item.rankLow,
    rankHigh: item.rankHigh,
    winRate: item.winRate,
    leaveOneOutSelections: item.leaveOneOutSelections,
  }));
}
