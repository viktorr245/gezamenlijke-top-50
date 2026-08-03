import { members, type MemberId, type Track } from "../data/tracks";
import { listAudioRecords } from "./audio-storage";
import { listSubmissions, type SubmissionIndex } from "./submission-storage";
import { listVotes } from "./vote-storage";

export type GroupPhase = "inzenden" | "stemmen" | "ranglijst";

export type MemberStatus = {
  memberId: MemberId;
  trackCount: number;
  audioCount: number;
  finalized: boolean;
  voteCount: number;
  votingDone: boolean;
};

export type GroupStatus = {
  phase: GroupPhase;
  readyForVoting: boolean;
  votingComplete: boolean;
  finalizedCount: number;
  completedVoterCount: number;
  totalTracks: number;
  members: MemberStatus[];
};

export async function loadGroupData(): Promise<{
  submissions: Partial<SubmissionIndex>;
  tracks: Track[];
  audioIds: Set<string>;
  voteChoices: Awaited<ReturnType<typeof listVotes>>;
  status: GroupStatus;
}> {
  const [submissions, audio] = await Promise.all([listSubmissions(), listAudioRecords()]);
  const audioIds = new Set(Object.keys(audio));
  const allFinal = members.every((member) => submissions[member.id]?.finalizedAt && submissions[member.id]?.tracks.length === 20);
  const allAudio = members.every((member) => (submissions[member.id]?.tracks ?? []).every((track) => audioIds.has(track.id)));
  const readyForVoting = Boolean(allFinal && allAudio);
  const voteChoices = readyForVoting ? await listVotes(submissions) : {};
  const statuses = members.map((member): MemberStatus => {
    const submission = submissions[member.id];
    const voteCount = voteChoices[member.id]?.length ?? 0;
    return {
      memberId: member.id,
      trackCount: submission?.tracks.length ?? 0,
      audioCount: (submission?.tracks ?? []).filter((track) => audioIds.has(track.id)).length,
      finalized: Boolean(submission?.finalizedAt),
      voteCount,
      votingDone: voteCount === 120,
    };
  });
  const votingComplete = readyForVoting && statuses.every((status) => status.votingDone);
  return {
    submissions,
    tracks: members.flatMap((member) => submissions[member.id]?.tracks ?? []),
    audioIds,
    voteChoices,
    status: {
      phase: votingComplete ? "ranglijst" : readyForVoting ? "stemmen" : "inzenden",
      readyForVoting,
      votingComplete,
      finalizedCount: statuses.filter((status) => status.finalized).length,
      completedVoterCount: statuses.filter((status) => status.votingDone).length,
      totalTracks: statuses.reduce((sum, status) => sum + status.trackCount, 0),
      members: statuses,
    },
  };
}
