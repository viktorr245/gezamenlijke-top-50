export const DISC_COUNT = 3;
export const MAX_DISC_SECONDS = 80 * 60;
export const TRACK_GAP_SECONDS = 2;

type RankedTrack = {
  id: string;
  duration: number;
};

export function discDurationSeconds(tracks: Pick<RankedTrack, "duration">[]): number {
  return tracks.reduce((total, track) => total + track.duration, 0)
    + Math.max(0, tracks.length - 1) * TRACK_GAP_SECONDS;
}

function isBetterScore(candidate: number[], current: number[]): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== current[index]) return candidate[index] < current[index];
  }
  return false;
}

/**
 * Finds the two best boundaries without ever changing the ranking order.
 * The longest disc is minimized first; ties prefer an even split and fuller
 * earlier discs so the result is stable.
 */
export function distributeRankedTracks(tracks: RankedTrack[]): string[][] {
  if (tracks.length < DISC_COUNT) {
    return Array.from({ length: DISC_COUNT }, (_, index) => tracks[index] ? [tracks[index].id] : []);
  }

  const prefixDurations = [0];
  tracks.forEach((track) => prefixDurations.push(prefixDurations.at(-1)! + track.duration));

  function segmentDuration(start: number, end: number): number {
    const count = end - start;
    return prefixDurations[end] - prefixDurations[start] + Math.max(0, count - 1) * TRACK_GAP_SECONDS;
  }

  let best: { firstEnd: number; secondEnd: number; score: number[] } | undefined;
  for (let firstEnd = 1; firstEnd <= tracks.length - 2; firstEnd += 1) {
    for (let secondEnd = firstEnd + 1; secondEnd <= tracks.length - 1; secondEnd += 1) {
      const durations = [
        segmentDuration(0, firstEnd),
        segmentDuration(firstEnd, secondEnd),
        segmentDuration(secondEnd, tracks.length),
      ];
      const counts = [firstEnd, secondEnd - firstEnd, tracks.length - secondEnd];
      const longest = Math.max(...durations);
      const score = [
        longest,
        longest - Math.min(...durations),
        Math.max(...counts) - Math.min(...counts),
        -firstEnd,
        -secondEnd,
      ];
      if (!best || isBetterScore(score, best.score)) {
        best = { firstEnd, secondEnd, score };
      }
    }
  }

  return [
    tracks.slice(0, best!.firstEnd).map((track) => track.id),
    tracks.slice(best!.firstEnd, best!.secondEnd).map((track) => track.id),
    tracks.slice(best!.secondEnd).map((track) => track.id),
  ];
}
