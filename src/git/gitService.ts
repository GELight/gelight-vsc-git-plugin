/**
 * Git service using VSCode's built-in Git extension API.
 * Handles standard Git operations: log, commit, push, staging, status.
 */
import * as vscode from 'vscode';
import { GitCommit, GitFileChange, FileChangeStatus } from './gitTypes';

// Types from vscode.git extension
interface GitExtension {
  getAPI(version: number): GitAPI;
}

interface GitAPI {
  repositories: Repository[];
  onDidOpenRepository: vscode.Event<Repository>;
  onDidCloseRepository: vscode.Event<Repository>;
}

interface Repository {
  rootUri: vscode.Uri;
  state: RepositoryState;
  inputBox: { value: string };
  log(options?: LogOptions): Promise<APICommit[]>;
  commit(message: string, opts?: CommitOptions): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: ForcePushMode): Promise<void>;
  add(paths: string[]): Promise<void>;
  revert(paths: string[]): Promise<void>;
  getCommit(ref: string): Promise<APICommit>;
  diff(cached?: boolean): Promise<string>;
  diffWithHEAD(path?: string): Promise<string>;
  diffBetween(ref1: string, ref2: string, path?: string): Promise<string>;
  show(ref: string, path: string): Promise<string>;
  clean(paths: string[]): Promise<void>;
  status(): Promise<void>;
  getRefs(query?: RefQuery): Promise<Ref[]>;
}

interface RepositoryState {
  HEAD: Branch | undefined;
  refs: Ref[];
  indexChanges: Change[];
  workingTreeChanges: Change[];
  untrackedChanges: Change[];
  onDidChange: vscode.Event<void>;
}

interface Branch {
  name?: string;
  commit?: string;
  upstream?: { name: string; commit?: string };
}

interface Ref {
  type: number; // 0=Head, 1=RemoteHead, 2=Tag
  name?: string;
  commit?: string;
}

interface Change {
  uri: vscode.Uri;
  originalUri: vscode.Uri;
  renameUri?: vscode.Uri;
  status: number;
}

interface LogOptions {
  maxEntries?: number;
  path?: string;
  ref?: string;
}

interface APICommit {
  hash: string;
  message: string;
  parents: string[];
  authorDate?: Date;
  authorName?: string;
  authorEmail?: string;
  commitDate?: Date;
}

interface CommitOptions {
  all?: boolean;
  amend?: boolean;
  signoff?: boolean;
  signCommit?: boolean;
  empty?: boolean;
}

interface RefQuery {
  contains?: string;
  count?: number;
  pattern?: string;
  sort?: 'alphabetically' | 'committerdate';
}

enum ForcePushMode {
  Force = 0,
  ForceWithLease = 1,
}

export class GitService implements vscode.Disposable {
  private _gitAPI: GitAPI | undefined;
  private _disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  public readonly onDidChangeState = this._onDidChangeState.event;

  constructor() {
    this._initGitAPI();
  }

  private _initGitAPI(): void {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (gitExtension) {
      if (gitExtension.isActive) {
        this._gitAPI = gitExtension.exports.getAPI(1);
        this._watchRepository();
      } else {
        gitExtension.activate().then(() => {
          this._gitAPI = gitExtension.exports.getAPI(1);
          this._watchRepository();
        });
      }
    }
  }

  private _watchRepository(): void {
    if (!this._gitAPI) { return; }

    const repo = this.getRepository();
    if (repo) {
      this._disposables.push(
        repo.state.onDidChange(() => this._onDidChangeState.fire())
      );
    }

    this._disposables.push(
      this._gitAPI.onDidOpenRepository(() => {
        const newRepo = this.getRepository();
        if (newRepo) {
          this._disposables.push(
            newRepo.state.onDidChange(() => this._onDidChangeState.fire())
          );
        }
        this._onDidChangeState.fire();
      })
    );
  }

  public getRepository(): Repository | undefined {
    return this._gitAPI?.repositories[0];
  }

  public getRepoPath(): string | undefined {
    return this.getRepository()?.rootUri.fsPath;
  }

  public getCurrentBranch(): string | undefined {
    return this.getRepository()?.state.HEAD?.name;
  }

  /**
   * Get commit log for the current branch (local commits only).
   */
  public async getLog(maxCount?: number): Promise<GitCommit[]> {
    const repo = this.getRepository();
    if (!repo) { return []; }

    const config = vscode.workspace.getConfiguration('gelightGit');
    const max = maxCount ?? config.get<number>('maxCommits', 150);

    try {
      const apiCommits = await repo.log({ maxEntries: max });
      const refs = repo.state.refs;

      return apiCommits.map(c => this._mapCommit(c, refs));
    } catch {
      return [];
    }
  }

  /**
   * Get details for a specific commit including changed files.
   */
  public async getCommitDetails(hash: string): Promise<{ commit: GitCommit; files: GitFileChange[] } | undefined> {
    const repo = this.getRepository();
    if (!repo) { return undefined; }

    try {
      const apiCommit = await repo.getCommit(hash);
      const refs = repo.state.refs;
      const commit = this._mapCommit(apiCommit, refs);

      // Get changed files via CLI (built-in API doesn't provide per-commit file list directly)
      const { GitCliService } = await import('./gitCliService.js');
      const cli = new GitCliService(repo.rootUri.fsPath);
      const files = await cli.getCommitFiles(hash);

      return { commit, files };
    } catch {
      return undefined;
    }
  }

  /**
   * Get working tree changes (unstaged).
   */
  public getWorkingTreeChanges(): GitFileChange[] {
    const repo = this.getRepository();
    if (!repo) { return []; }
    return repo.state.workingTreeChanges.map(c => this._mapChange(c, false));
  }

  /**
   * Get index changes (staged).
   */
  public getIndexChanges(): GitFileChange[] {
    const repo = this.getRepository();
    if (!repo) { return []; }
    return repo.state.indexChanges.map(c => this._mapChange(c, true));
  }

  /**
   * Get untracked files.
   */
  public getUntrackedFiles(): GitFileChange[] {
    const repo = this.getRepository();
    if (!repo) { return []; }
    return repo.state.untrackedChanges.map(c => ({
      path: vscode.workspace.asRelativePath(c.uri),
      status: FileChangeStatus.Untracked,
      staged: false,
    }));
  }

  /**
   * Commit staged changes.
   */
  public async commit(message: string, amend: boolean = false): Promise<void> {
    const repo = this.getRepository();
    if (!repo) { throw new Error('No repository found'); }
    await repo.commit(message, { amend });
  }

  /**
   * Push to remote.
   */
  public async push(): Promise<void> {
    const repo = this.getRepository();
    if (!repo) { throw new Error('No repository found'); }
    const head = repo.state.HEAD;
    await repo.push(undefined, head?.name);
  }

  /**
   * Force push with lease.
   */
  public async forcePush(): Promise<void> {
    const repo = this.getRepository();
    if (!repo) { throw new Error('No repository found'); }
    const head = repo.state.HEAD;
    await repo.push(undefined, head?.name, false, ForcePushMode.ForceWithLease);
  }

  /**
   * Stage files.
   */
  public async stageFiles(paths: string[]): Promise<void> {
    const repo = this.getRepository();
    if (!repo) { throw new Error('No repository found'); }
    await repo.add(paths);
  }

  /**
   * Unstage files.
   */
  public async unstageFiles(paths: string[]): Promise<void> {
    const repo = this.getRepository();
    if (!repo) { throw new Error('No repository found'); }
    await repo.revert(paths);
  }

  /**
   * Get the HEAD commit message (for amend workflow).
   */
  public async getHeadCommitMessage(): Promise<string> {
    const repo = this.getRepository();
    if (!repo) { return ''; }
    try {
      const headCommit = await repo.getCommit('HEAD');
      return headCommit.message;
    } catch {
      return '';
    }
  }

  private _mapCommit(apiCommit: APICommit, refs: Ref[]): GitCommit {
    const tags = refs
      .filter(r => r.type === 2 && r.commit === apiCommit.hash)
      .map(r => r.name ?? '')
      .filter(Boolean);

    const branchRefs = refs
      .filter(r => (r.type === 0 || r.type === 1) && r.commit === apiCommit.hash)
      .map(r => r.name ?? '')
      .filter(Boolean);

    const messageParts = apiCommit.message.split('\n');

    return {
      hash: apiCommit.hash,
      shortHash: apiCommit.hash.substring(0, 7),
      message: messageParts[0] ?? '',
      fullMessage: apiCommit.message,
      authorName: apiCommit.authorName ?? 'Unknown',
      authorEmail: apiCommit.authorEmail ?? '',
      date: apiCommit.authorDate ?? new Date(),
      parents: apiCommit.parents ?? [],
      tags,
      refs: branchRefs,
    };
  }

  private _mapChange(change: Change, staged: boolean): GitFileChange {
    const status = this._mapStatus(change.status);
    const result: GitFileChange = {
      path: vscode.workspace.asRelativePath(change.uri),
      status,
      staged,
    };
    if (change.renameUri) {
      result.originalPath = vscode.workspace.asRelativePath(change.originalUri);
    }
    return result;
  }

  private _mapStatus(status: number): FileChangeStatus {
    // VSCode git extension status enum values
    switch (status) {
      case 0: return FileChangeStatus.Modified; // INDEX_MODIFIED
      case 1: return FileChangeStatus.Added;    // INDEX_ADDED
      case 2: return FileChangeStatus.Deleted;  // INDEX_DELETED
      case 3: return FileChangeStatus.Renamed;  // INDEX_RENAMED
      case 4: return FileChangeStatus.Copied;   // INDEX_COPIED
      case 5: return FileChangeStatus.Modified;  // MODIFIED
      case 6: return FileChangeStatus.Deleted;   // DELETED
      case 7: return FileChangeStatus.Untracked; // UNTRACKED
      default: return FileChangeStatus.Modified;
    }
  }

  dispose() {
    this._onDidChangeState.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
