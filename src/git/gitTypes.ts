/**
 * Core type definitions for the GELight Git plugin.
 */

/** Represents a single Git commit. */
export interface GitCommit {
  /** Full commit hash */
  hash: string;
  /** Short commit hash (first 7 chars) */
  shortHash: string;
  /** Commit message (first line) */
  message: string;
  /** Full commit message including body */
  fullMessage: string;
  /** Author name */
  authorName: string;
  /** Author email */
  authorEmail: string;
  /** Commit date */
  date: Date;
  /** Parent commit hashes */
  parents: string[];
  /** Tags associated with this commit */
  tags: string[];
  /** Branch refs pointing to this commit */
  refs: string[];
}

/** Status of a changed file. */
export enum FileChangeStatus {
  Modified = "M",
  Added = "A",
  Deleted = "D",
  Renamed = "R",
  Copied = "C",
  Untracked = "?",
}

/** A file change in the working tree or index. */
export interface GitFileChange {
  /** File path relative to repo root */
  path: string;
  /** Original path (for renames) */
  originalPath?: string;
  /** Change status */
  status: FileChangeStatus;
  /** Whether the file is staged (in index) */
  staged: boolean;
}

/** Represents an entry in the file tree structure. */
export interface FileTreeNode {
  /** Display name (filename or folder name) */
  name: string;
  /** Full relative path */
  path: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** Children nodes (if directory) */
  children: FileTreeNode[];
  /** File change info (if file) */
  change?: GitFileChange;
  /** Checked state */
  checked: boolean;
}

/** Graph layout data for a commit row. */
export interface GraphColumn {
  /** Column index (0-based) */
  column: number;
  /** Color for this branch line */
  color: string;
}

export interface GraphRow {
  /** The commit */
  commit: GitCommit;
  /** Column position of this commit's dot */
  column: number;
  /** Color of this commit's dot/line */
  color: string;
  /** Active branch lines passing through this row */
  lines: GraphLine[];
}

export interface GraphLine {
  /** Starting column */
  fromColumn: number;
  /** Ending column */
  toColumn: number;
  /** Color of this line */
  color: string;
  /** Line type: 'straight' | 'merge-left' | 'merge-right' | 'fork-left' | 'fork-right' */
  type: "straight" | "merge-left" | "merge-right" | "fork-left" | "fork-right";
}

// --- Message types for extension <-> webview communication ---

/** Messages from Extension Host to Webview */
export type ExtensionToWebviewMessage =
  | { type: "updateCommits"; commits: GraphRow[] }
  | { type: "updateCommitDetails"; commit: GitCommit; files: GitFileChange[] }
  | {
      type: "updateChanges";
      staged: GitFileChange[];
      unstaged: GitFileChange[];
      untracked: GitFileChange[];
    }
  | { type: "updateHeadMessage"; message: string }
  | {
      type: "operationComplete";
      operation: string;
      success: boolean;
      error?: string;
    }
  | { type: "setStrings"; strings: Record<string, string> }
  | { type: "clearSelection" };

/** Messages from Webview to Extension Host */
export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "selectCommit"; hash: string }
  | { type: "copyHash"; hash: string }
  | { type: "requestCommitDetails"; hash: string }
  | { type: "commit"; message: string; amend: boolean; files: string[] }
  | { type: "push" }
  | { type: "forcePush" }
  | { type: "stageFiles"; paths: string[] }
  | { type: "unstageFiles"; paths: string[] }
  | { type: "toggleAmend"; enabled: boolean }
  | { type: "openCommitOverview" }
  | { type: "searchCommits"; query: string }
  | { type: "searchFiles"; query: string }
  | { type: "openFile"; path: string; status: string }
  | {
      type: "openDiffForCommit";
      hash: string;
      filePath: string;
      status: string;
    }
  | { type: "requestRefresh" };
