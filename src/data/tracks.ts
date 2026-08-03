export type MemberId = "viktor" | "daniel" | "keano" | "sander" | "jurjan";

export type Member = {
  id: MemberId;
  name: string;
  color: string;
};

export type Track = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  owner: MemberId;
  duration: number;
  cover: string;
  previewUrl?: string;
  source?: "itunes";
  sourceId?: string;
  sourceUrl?: string;
  // Oude gecachte records kunnen deze velden nog bevatten. De nieuwe
  // ranglijst gebruikt ze niet; scores worden uitsluitend uit stemmen berekend.
  score?: number;
  tone?: number;
};

export const members: Member[] = [
  { id: "viktor", name: "Viktor", color: "#980f1d" },
  { id: "daniel", name: "Daniel", color: "#174c3b" },
  { id: "keano", name: "Keano", color: "#d39a19" },
  { id: "sander", name: "Sander", color: "#4773a6" },
  { id: "jurjan", name: "Jurjan", color: "#202224" },
];

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

export function isMemberId(id: unknown): id is MemberId {
  return typeof id === "string" && members.some((member) => member.id === id);
}

export function getMember(id: string): Member {
  return members.find((member) => member.id === id) ?? members[0];
}
