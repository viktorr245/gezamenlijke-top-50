import { members, type MemberId, type Track } from "../data/tracks";
import type { VoteChoice } from "./vote-storage";

export type TrackHistoryComparison = {
  id: string;
  opponent: Track;
  selectedThisTrack: boolean;
  chosenAt: string;
};

export type TrackHistoryVoter = {
  voterId: MemberId;
  selectedThisTrackCount: number;
  comparisons: TrackHistoryComparison[];
};

export type TrackHistory = {
  track: Track;
  comparisonCount: number;
  selectedThisTrackCount: number;
  selectedOtherTrackCount: number;
  voters: TrackHistoryVoter[];
};

export function buildTrackHistory(tracks: Track[], choices: VoteChoice[], trackId: string): TrackHistory | undefined {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const track = trackById.get(trackId);
  if (!track) return undefined;

  const comparisonsByVoter = new Map<MemberId, TrackHistoryComparison[]>();
  for (const choice of choices) {
    if (choice.leftId !== trackId && choice.rightId !== trackId) continue;
    const opponentId = choice.leftId === trackId ? choice.rightId : choice.leftId;
    const opponent = trackById.get(opponentId);
    if (!opponent) continue;
    const comparisons = comparisonsByVoter.get(choice.voterId) ?? [];
    comparisons.push({
      id: choice.id,
      opponent,
      selectedThisTrack: choice.winnerId === trackId,
      chosenAt: choice.chosenAt,
    });
    comparisonsByVoter.set(choice.voterId, comparisons);
  }

  const voters = members.flatMap((member): TrackHistoryVoter[] => {
    const comparisons = comparisonsByVoter.get(member.id);
    if (!comparisons?.length) return [];
    comparisons.sort((left, right) => left.chosenAt.localeCompare(right.chosenAt) || left.id.localeCompare(right.id));
    return [{
      voterId: member.id,
      selectedThisTrackCount: comparisons.filter((comparison) => comparison.selectedThisTrack).length,
      comparisons,
    }];
  });
  const comparisonCount = voters.reduce((sum, voter) => sum + voter.comparisons.length, 0);
  const selectedThisTrackCount = voters.reduce((sum, voter) => sum + voter.selectedThisTrackCount, 0);

  return {
    track,
    comparisonCount,
    selectedThisTrackCount,
    selectedOtherTrackCount: comparisonCount - selectedThisTrackCount,
    voters,
  };
}
