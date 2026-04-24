export type ContentSource = 'youtube' | 'ecosystem' | 'james-send';
export type DedupStatus = 'unique' | 'conflict' | 'reviewed';
export type SelectionStatus = 'empty' | 'pending' | 'approved';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface CandidateScoring {
  virality: number;
  actionability: number;
  newType: number;
  deliverable: number;
  claudeCode: number;
  cortextOS: number;
  skoolCTA: number;
}

export interface Candidate {
  id: string;
  source: ContentSource;
  sourceId: string;
  title: string;
  creator?: string;
  scoring: CandidateScoring;
  overallScore: number;
  dedupStatus: DedupStatus;
  conflictWith?: string;
  fullPath: string;
  rawContent?: string;
}

export interface Selection {
  type: 1 | 2 | 3 | 4;
  candidate?: Candidate;
  status: SelectionStatus;
}

export interface PipelineData {
  date: string;
  candidates: Candidate[];
  selections: Record<number, Selection>;
  filtered: Candidate[];
  approvalStatus: ApprovalStatus;
}

export function formatScore(scores: CandidateScoring): string {
  const values = Object.values(scores);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return avg.toFixed(1);
}
