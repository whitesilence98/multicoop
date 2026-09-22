import { create } from "zustand";

export interface ChatMember {
  id: string;
  username: string;
  role: string;
  badge: string;
  color: string;
  kind: "human" | "bot";
  status: string;
}

export interface ChatMessage {
  id: string;
  sender: ChatMember;
  text: string;
  mentions: string[];
  ts: string;
}

interface ChatState {
  messages: ChatMessage[];
  members: ChatMember[];
  wsStatus: ConnStatus;
  unreadMentions: number;
  // Actions
  pushMessage: (m: ChatMessage) => void;
  setMembers: (m: ChatMember[]) => void;
  upsertMember: (m: ChatMember) => void;
  removeMember: (id: string) => void;
  setWsStatus: (s: ConnStatus) => void;
  clearUnread: () => void;
  reset: () => void;
}

type ConnStatus = "connecting" | "open" | "closed";

const MAX_MESSAGES = 500;

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  members: [],
  wsStatus: "connecting",
  unreadMentions: 0,

  pushMessage: (m) =>
    set((s) => {
      const next = [...s.messages, m].slice(-MAX_MESSAGES);
      return { messages: next };
    }),

  setMembers: (members) => set({ members }),

  upsertMember: (m) =>
    set((s) => ({
      members: [...s.members.filter((x) => x.id !== m.id), m],
    })),

  removeMember: (id) =>
    set((s) => ({ members: s.members.filter((x) => x.id !== id) })),

  setWsStatus: (wsStatus) => set({ wsStatus }),

  clearUnread: () => set({ unreadMentions: 0 }),

  reset: () => set({ messages: [], members: [], unreadMentions: 0, wsStatus: "connecting" }),
}));