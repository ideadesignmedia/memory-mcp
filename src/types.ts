export type MemoryType = "preference" | "profile" | "project" | "fact" | "constraint";

export interface MemoryItem {
  id: string;
  ownerId: string;
  type: MemoryType;
  subject: string;
  content: string;
  importance: number;
  useCount: number;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  pinned: boolean;
  consent: boolean;
  sensitivity: string[];
}
