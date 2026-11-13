export type Section =
  | "all"
  | "favorites"
  | "archive"
  | "trash"
  | "subscription"
  | "settings"
  | "admin";
export type Summary = { current: string; known: string; questions: string };
export type Action = {
  id: string;
  text: string;
  done: boolean;
  source?: string;
};
export type Idea = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  status: "待梳理" | "推进中" | "暂缓" | "已完成";
  favorite: boolean;
  archived: boolean;
  summary: Summary;
  actions: Action[];
  mode: "quick" | "deep";
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  summaryVersions: { version: number; summary: Summary; at: string }[];
  adopted: string[];
};
export type User = {
  id: string;
  email: string;
  aiConsent: boolean;
  admin: boolean;
};
export type Config = {
  authMode?: string;
  development: boolean;
  aiDemo: boolean;
  provider: string;
  quickModel: string;
  deepModel: string;
  policyURL: string;
  paymentEnabled: boolean;
};
export type Quota = {
  total: number;
  used: number;
  reserved: number;
  available: number;
  resetAt: string;
  plan: string;
  nextPeriod?: {
    startsAt: string;
    endsAt: string;
    plan: string;
    total: number;
  } | null;
};
export type Message = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  requestId: string;
  state: string;
  charged?: number;
  error?: string;
  kind?: string;
  proposal?: { summary: Summary; actions: string[] };
  baseVersion?: number;
  note?: string;
  limited?: boolean;
};
export const blankIdea = (): Idea => ({
  id: crypto.randomUUID(),
  title: "",
  body: "",
  tags: [],
  status: "待梳理",
  favorite: false,
  archived: false,
  summary: { current: "", known: "", questions: "" },
  actions: [],
  mode: "quick",
  version: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  summaryVersions: [],
  adopted: [],
});
export const statuses: Idea["status"][] = [
  "待梳理",
  "推进中",
  "暂缓",
  "已完成",
];
