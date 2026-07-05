export const NOTE_LIFECYCLE_STATES = ["raw", "triaged", "curated", "verified"] as const;
export type NoteLifecycleState = (typeof NOTE_LIFECYCLE_STATES)[number];
export const NOTE_REVIEW_REASONS = ["conflict", "manual"] as const;
export type NoteReviewReason = (typeof NOTE_REVIEW_REASONS)[number];

export interface Note {
  id: string;
  title: string;
  content: string;
  projectId: string;
  projectName?: string;
  tags: string[];
  lifecycleState?: NoteLifecycleState;
  reviewAfter?: string | null;
  lastConfirmedAt?: string | null;
  reviewReason?: NoteReviewReason | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteInput {
  title: string;
  content: string;
  projectId: string;
  projectName?: string;
  tags?: string[];
  lifecycleState?: NoteLifecycleState;
  reviewAfter?: string | null;
  reviewReason?: NoteReviewReason | null;
}

export interface NoteProjectSummary {
  projectId: string;
  projectName?: string;
  noteCount: number;
  latestUpdatedAt: string;
}

export const NOTE_MAINTENANCE_QUEUE_REASONS = ["raw", "expired", "conflict", "manual"] as const;
export type NoteMaintenanceQueueReason = (typeof NOTE_MAINTENANCE_QUEUE_REASONS)[number];

export interface NoteMaintenanceQueueItem {
  id: string;
  kind: "note";
  projectId: string;
  projectName: string;
  resourceId: string;
  title: string;
  excerpt: string;
  reasons: NoteMaintenanceQueueReason[];
  lifecycleState?: NoteLifecycleState;
  lastConfirmedAt?: string | null;
  reviewAfter?: string | null;
  updatedAt: string;
  suggestedActions: string[];
}

export interface NoteMaintenanceQueueListResult {
  items: NoteMaintenanceQueueItem[];
  nextCursor?: string;
  totals: {
    byReason: Partial<Record<NoteMaintenanceQueueReason, number>>;
  };
}
