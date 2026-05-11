export interface GitBranches {
  branches: string[];
  current: string;
}

export interface GitStatus {
  branch: string;
  upstream: string;
  upstreamRemoteUrl: string | null;
  ahead: number;
  behind: number;
  lastFetchedAt: string | null;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  date: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'other';

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
}

export interface CommitDetail {
  sha: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  date: string;
  files: DiffFile[];
}
