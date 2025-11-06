// v2 minimal memory item (no owners, no categories)
export interface MemoryItem {
  id: string;
  subject: string;
  content: string;
  dateCreated: string;
  dateUpdated: string;
  expiresAt?: string;
  embedding?: number[];
}
