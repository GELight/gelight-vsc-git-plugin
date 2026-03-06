/**
 * GitGraphViewProvider — WebviewViewProvider for the Git Graph panel.
 * Renders the commit graph visualization and handles user interactions.
 */
import * as vscode from 'vscode';
import { GitService } from '../../git/gitService';
import { GitCliService } from '../../git/gitCliService';
import { GitWatcher } from '../../git/gitWatcher';
import { calculateGraphLayout } from '../../git/graphLayout';
import { getNonce, getWebviewUri } from '../../utils/helpers';
import { WebviewToExtensionMessage } from '../../git/gitTypes';

export class GitGraphViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gelightGitGraph';

  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _gitService: GitService,
    private readonly _gitWatcher: GitWatcher,
  ) {
    // Listen for git changes and push updates
    this._disposables.push(
      this._gitWatcher.onDidChange(() => this._updateGraph())
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToExtensionMessage) => this._handleMessage(msg),
      undefined,
      this._disposables,
    );

    // Send initial data when webview is ready
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._updateGraph();
      }
    });
  }

  /**
   * Refresh the graph data and send to webview.
   */
  public async _updateGraph(): Promise<void> {
    if (!this._view?.visible) { return; }

    const commits = await this._gitService.getLog();
    const graphRows = calculateGraphLayout(commits);

    this._view.webview.postMessage({
      type: 'updateCommits',
      commits: graphRows,
    });
  }

  private async _handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this._sendLocalizedStrings();
        await this._updateGraph();
        break;

      case 'requestCommitDetails':
        await this._sendCommitDetails(msg.hash);
        break;

      case 'copyHash':
        await vscode.env.clipboard.writeText(msg.hash);
        vscode.window.showInformationMessage(`Copied: ${msg.hash.substring(0, 7)}`);
        break;

      case 'requestRefresh':
        await this._updateGraph();
        break;

      case 'searchCommits':
        // Client-side filtering — commits are already in webview
        break;
    }
  }

  private async _sendCommitDetails(hash: string): Promise<void> {
    const details = await this._gitService.getCommitDetails(hash);
    if (details && this._view) {
      this._view.webview.postMessage({
        type: 'updateCommitDetails',
        commit: details.commit,
        files: details.files,
      });
    }
  }

  private async _sendLocalizedStrings(): Promise<void> {
    if (!this._view) { return; }
    this._view.webview.postMessage({
      type: 'setStrings',
      strings: {
        search: vscode.l10n.t('Search...'),
        noCommits: vscode.l10n.t('No commits found'),
        author: vscode.l10n.t('Author'),
        date: vscode.l10n.t('Date'),
        parents: vscode.l10n.t('Parents'),
        changedFiles: vscode.l10n.t('Changed Files'),
        tags: vscode.l10n.t('Tags'),
        commitDetails: vscode.l10n.t('Commit Details'),
      },
    });
  }

  /**
   * Handle context menu commands routed from the extension.
   */
  public async handleEditCommitMessage(commitHash: string): Promise<void> {
    const details = await this._gitService.getCommitDetails(commitHash);
    const currentMessage = details?.commit.fullMessage ?? '';

    const newMessage = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Enter new commit message'),
      value: currentMessage,
      validateInput: (value) => value.trim() ? null : 'Message cannot be empty',
    });

    if (newMessage === undefined) { return; }

    const repoPath = this._gitService.getRepoPath();
    if (!repoPath) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Git operation in progress...') },
      async () => {
        const cli = new GitCliService(repoPath);
        try {
          await cli.editCommitMessage(commitHash, newMessage);
          this._gitWatcher.forceUpdate();
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to edit commit message: ${errorMsg}`);
        }
      }
    );
  }

  public async handleDeleteCommit(commitHash: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t('Are you sure you want to delete this commit? This will rewrite history.'),
      { modal: true },
      vscode.l10n.t('Delete commit'),
    );

    if (!confirm) { return; }

    const repoPath = this._gitService.getRepoPath();
    if (!repoPath) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Git operation in progress...') },
      async () => {
        const cli = new GitCliService(repoPath);
        try {
          await cli.deleteCommit(commitHash);
          this._gitWatcher.forceUpdate();
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to delete commit: ${errorMsg}`);
        }
      }
    );
  }

  public async handleResetToCommit(commitHash: string): Promise<void> {
    const repoPath = this._gitService.getRepoPath();
    if (!repoPath) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Git operation in progress...') },
      async () => {
        const cli = new GitCliService(repoPath);
        try {
          await cli.softReset(commitHash);
          this._gitWatcher.forceUpdate();
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to reset: ${errorMsg}`);
        }
      }
    );
  }

  public async handleFixup(commitHashes: string[]): Promise<void> {
    const repoPath = this._gitService.getRepoPath();
    if (!repoPath || commitHashes.length < 2) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Git operation in progress...') },
      async () => {
        const cli = new GitCliService(repoPath);
        try {
          await cli.fixup(commitHashes);
          this._gitWatcher.forceUpdate();
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Fixup failed: ${errorMsg}`);
        }
      }
    );
  }

  public async handleSquash(commitHashes: string[]): Promise<void> {
    const repoPath = this._gitService.getRepoPath();
    if (!repoPath || commitHashes.length < 2) { return; }

    const message = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Enter squash commit message'),
      placeHolder: 'Squash commit message',
    });

    if (message === undefined) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Git operation in progress...') },
      async () => {
        const cli = new GitCliService(repoPath);
        try {
          await cli.squash(commitHashes, message || undefined);
          this._gitWatcher.forceUpdate();
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Squash failed: ${errorMsg}`);
        }
      }
    );
  }

  public async handleSoftResetMultiple(commitHashes: string[]): Promise<void> {
    const repoPath = this._gitService.getRepoPath();
    if (!repoPath || commitHashes.length === 0) { return; }

    // Soft reset to the parent of the oldest selected commit
    const oldestHash = commitHashes[commitHashes.length - 1];

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Git operation in progress...') },
      async () => {
        const cli = new GitCliService(repoPath);
        try {
          await cli.softReset(`${oldestHash}~1`);
          this._gitWatcher.forceUpdate();
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Soft reset failed: ${errorMsg}`);
        }
      }
    );
  }

  public async handleSoftResetFileFromCommit(commitHash: string, filePath: string): Promise<void> {
    const repoPath = this._gitService.getRepoPath();
    if (!repoPath) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Git operation in progress...') },
      async () => {
        const cli = new GitCliService(repoPath);
        try {
          await cli.softResetFileFromCommit(commitHash, filePath);
          this._gitWatcher.forceUpdate();
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to reset file from commit: ${errorMsg}`);
        }
      }
    );
  }

  /**
   * Clear the current selection in the webview.
   */
  public clearSelection(): void {
    this._view?.webview.postMessage({ type: 'clearSelection' });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = getWebviewUri(webview, this._extensionUri, ['dist', 'webview-ui', 'gitGraph.js']);
    const styleUri = getWebviewUri(webview, this._extensionUri, ['webview-ui', 'gitGraph', 'styles.css']);

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <title>Git Graph</title>
</head>
<body>
  <div id="search-bar">
    <input type="text" id="search-input" placeholder="Search..." />
  </div>
  <div id="graph-container">
    <div id="commit-list"></div>
    <div id="commit-details" class="hidden"></div>
  </div>
  <div id="empty-state" class="hidden">
    <p id="no-commits-message">No commits found</p>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }
}
