/**
 * Git watcher — monitors file system and git state changes,
 * notifying views with debounced events.
 */
import * as vscode from 'vscode';
import { GitService } from './gitService';

export class GitWatcher implements vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  constructor(private readonly _gitService: GitService) {
    this._init();
  }

  private _init(): void {
    // Watch git state changes via built-in API
    this._disposables.push(
      this._gitService.onDidChangeState(() => this._scheduleUpdate())
    );

    // Watch file system changes
    const fsWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    this._disposables.push(
      fsWatcher,
      fsWatcher.onDidChange(() => this._scheduleUpdate()),
      fsWatcher.onDidCreate(() => this._scheduleUpdate()),
      fsWatcher.onDidDelete(() => this._scheduleUpdate()),
    );
  }

  private _scheduleUpdate(): void {
    const config = vscode.workspace.getConfiguration('gelightGit');
    const autoRefresh = config.get<boolean>('autoRefresh', true);
    if (!autoRefresh) { return; }

    const debounce = config.get<number>('autoRefreshDebounce', 300);

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    this._debounceTimer = setTimeout(() => {
      this._onDidChange.fire();
    }, debounce);
  }

  /**
   * Force an immediate update (bypasses debounce).
   */
  public forceUpdate(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._onDidChange.fire();
  }

  dispose(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._onDidChange.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
