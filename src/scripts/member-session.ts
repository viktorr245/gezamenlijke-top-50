import { isMemberId, type MemberId } from "../data/tracks";

export const MEMBER_STORAGE_KEY = "gezamenlijke-top-50-member";

export function getActiveMember(): MemberId {
  const sessionMember = document.documentElement.dataset.memberId;
  if (isMemberId(sessionMember)) return sessionMember;
  const value = window.localStorage.getItem(MEMBER_STORAGE_KEY);
  return isMemberId(value) ? value : "viktor";
}
