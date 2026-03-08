/**
 * CommitChangesViewProvider — WebviewViewProvider for the Commit Changes panel.
 * Shows changed files, commit form, amend toggle, push buttons.
 */
import * as vscode from "vscode";
import * as path from "path";
import { GitService } from "../../git/gitService";
import { GitCliService } from "../../git/gitCliService";
import { GitWatcher } from "../../git/gitWatcher";
import { getNonce, getWebviewUri } from "../../utils/helpers";
import { GitFileChange, WebviewToExtensionMessage } from "../../git/gitTypes";

export class CommitChangesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "gelightCommitChanges";

  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];

  private readonly _onSelectCommitInGraph = new vscode.EventEmitter<string>();
  public readonly onSelectCommitInGraph = this._onSelectCommitInGraph.event;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _gitService: GitService,
    private readonly _gitWatcher: GitWatcher,
  ) {
    this._disposables.push(
      this._gitWatcher.onDidChange(() => {
        this._updateChanges();
        this._updateUnpushedCommits();
      }),
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

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToExtensionMessage) => this._handleMessage(msg),
      undefined,
      this._disposables,
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._updateChanges();
      }
    });
  }

  /**
   * Send current file changes to the webview.
   */
  public async _updateChanges(): Promise<void> {
    if (!this._view?.visible) {
      return;
    }

    const staged = this._gitService.getIndexChanges();
    const unstaged = this._gitService.getWorkingTreeChanges();
    const untracked = this._gitService.getUntrackedFiles();

    // Update Activity Bar badge with total changed file count
    const totalChanges = staged.length + unstaged.length + untracked.length;
    this._view.badge =
      totalChanges > 0
        ? { tooltip: `${totalChanges} changed files`, value: totalChanges }
        : undefined;

    this._view.webview.postMessage({
      type: "updateChanges",
      staged,
      unstaged,
      untracked,
    });
  }

  /**
   * Send unpushed commits to the webview.
   */
  private async _updateUnpushedCommits(): Promise<void> {
    if (!this._view?.visible) {
      return;
    }

    const result = await this._gitService.getUnpushedCommits();
    this._view.webview.postMessage({
      type: "updateUnpushedCommits",
      commits: result.commits,
      hasUpstream: result.hasUpstream,
    });
  }

  private async _handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this._sendLocalizedStrings();
        await this._updateChanges();
        await this._updateUnpushedCommits();
        break;

      case "commit":
        await this._handleCommit(msg.message, msg.amend, msg.files);
        break;

      case "push":
        await this._handlePush();
        break;

      case "forcePush":
        await this._handleForcePush();
        break;

      case "stageFiles":
        await this._handleStageFiles(msg.paths);
        break;

      case "unstageFiles":
        await this._handleUnstageFiles(msg.paths);
        break;

      case "toggleAmend":
        await this._handleAmendToggle(msg.enabled);
        break;

      case "openCommitOverview":
        await this._handleOpenCommitOverview();
        break;

      case "openFile":
        await this._handleOpenFile(msg.path, msg.status);
        break;

      case "openDiffForCommit":
        await this._handleOpenDiffForCommit(msg.hash, msg.filePath, msg.status);
        break;

      case "copyHash":
        await vscode.env.clipboard.writeText(msg.hash);
        vscode.window.showInformationMessage(
          `Copied: ${msg.hash.substring(0, 7)}`,
        );
        break;

      case "selectCommitInGraph":
        this._onSelectCommitInGraph.fire(msg.hash);
        break;

      case "requestRefresh":
        await this._updateChanges();
        break;
    }
  }

  private async _handleCommit(
    message: string,
    amend: boolean,
    files: string[],
  ): Promise<void> {
    if (!message.trim() && !amend) {
      vscode.window.showWarningMessage("Commit message cannot be empty.");
      return;
    }

    const repoPath = this._gitService.getRepoPath();
    if (!repoPath) {
      vscode.window.showErrorMessage("No Git repository found.");
      return;
    }

    try {
      const cli = new GitCliService(repoPath);

      // Stage selected files first
      if (files.length > 0) {
        await cli.stageFiles(files);
      }

      await cli.commit(message, amend);
      await this._gitService.refreshState();
      this._gitWatcher.forceUpdate();

      // Clear the commit message in webview
      this._view?.webview.postMessage({
        type: "operationComplete",
        operation: "commit",
        success: true,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Commit failed: ${errorMsg}`);
      this._view?.webview.postMessage({
        type: "operationComplete",
        operation: "commit",
        success: false,
        error: errorMsg,
      });
    }
  }

  private async _handlePush(): Promise<void> {
    const repoPath = this._gitService.getRepoPath();
    if (!repoPath) {
      vscode.window.showErrorMessage("No Git repository found.");
      return;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Pushing..." },
        async () => {
          const cli = new GitCliService(repoPath);
          await cli.push();
        },
      );
      vscode.window.showInformationMessage("Push successful.");
      await this._gitService.refreshState();
      this._gitWatcher.forceUpdate();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Push failed: ${errorMsg}`);
    }
  }

  private async _handleForcePush(): Promise<void> {
    const repoPath = this._gitService.getRepoPath();
    if (!repoPath) {
      vscode.window.showErrorMessage("No Git repository found.");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Are you sure you want to force push? This can overwrite remote changes.",
      ),
      { modal: true },
      "Force Push",
    );

    if (!confirm) {
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Force pushing...",
        },
        async () => {
          const cli = new GitCliService(repoPath);
          await cli.forcePush();
        },
      );
      vscode.window.showInformationMessage("Force push successful.");
      await this._gitService.refreshState();
      this._gitWatcher.forceUpdate();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Force push failed: ${errorMsg}`);
    }
  }

  private async _handleStageFiles(paths: string[]): Promise<void> {
    try {
      await this._gitService.stageFiles(paths);
      this._gitWatcher.forceUpdate();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to stage files: ${errorMsg}`);
    }
  }

  private async _handleUnstageFiles(paths: string[]): Promise<void> {
    try {
      await this._gitService.unstageFiles(paths);
      this._gitWatcher.forceUpdate();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to unstage files: ${errorMsg}`);
    }
  }

  private async _handleAmendToggle(enabled: boolean): Promise<void> {
    if (enabled) {
      const headMessage = await this._gitService.getHeadCommitMessage();
      this._view?.webview.postMessage({
        type: "updateHeadMessage",
        message: headMessage,
      });
    }
  }

  private async _handleOpenCommitOverview(): Promise<void> {
    // Fetch commits and send to webview for the overlay modal
    const commits = await this._gitService.getLog();
    // We reuse the updateCommits message type — the webview handles
    // routing it to the modal when in overview mode
    this._view?.webview.postMessage({
      type: "updateCommits",
      commits: commits.map((c) => ({
        commit: c,
        column: 0,
        color: "#569CD6",
        lines: [],
      })),
    });
  }

  /**
   * Open a file from the changes tree. Shows a side-by-side diff for modified files.
   */
  private async _handleOpenFile(
    filePath: string,
    status: string,
  ): Promise<void> {
    const repoPath = this._gitService.getRepoPath();
    if (!repoPath) {
      return;
    }

    const fileUri = vscode.Uri.file(path.join(repoPath, filePath));

    if (status === "D") {
      // Deleted file — show the HEAD version
      const gitUri = fileUri.with({
        scheme: "git",
        query: JSON.stringify({ path: fileUri.fsPath, ref: "~" }),
      });
      await vscode.commands.executeCommand("vscode.open", gitUri);
    } else if (status === "M") {
      // Modified file — show side-by-side diff (HEAD vs working tree)
      const gitUri = fileUri.with({
        scheme: "git",
        query: JSON.stringify({ path: fileUri.fsPath, ref: "~" }),
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        gitUri,
        fileUri,
        `${filePath} (Working Tree Changes)`,
      );
    } else {
      // Added / Untracked / other — just open the file
      await vscode.commands.executeCommand("vscode.open", fileUri);
    }
  }

  /**
   * Open a side-by-side diff for a file in a specific commit (used by commit overview modal).
   */
  private async _handleOpenDiffForCommit(
    hash: string,
    filePath: string,
    status: string,
  ): Promise<void> {
    const repoPath = this._gitService.getRepoPath();
    if (!repoPath) {
      return;
    }

    const absolutePath = path.join(repoPath, filePath);
    const fileUri = vscode.Uri.file(absolutePath);

    if (status === "D") {
      const beforeUri = vscode.Uri.from({
        scheme: "git",
        path: fileUri.path,
        query: JSON.stringify({ path: absolutePath, ref: `${hash}~1` }),
      });
      await vscode.commands.executeCommand("vscode.open", beforeUri);
    } else if (status === "A") {
      const emptyUri = vscode.Uri.from({
        scheme: "git",
        path: fileUri.path,
        query: JSON.stringify({ path: absolutePath, ref: `${hash}~1` }),
      });
      const afterUri = vscode.Uri.from({
        scheme: "git",
        path: fileUri.path,
        query: JSON.stringify({ path: absolutePath, ref: hash }),
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        emptyUri,
        afterUri,
        `${filePath} (${hash.substring(0, 7)})`,
      );
    } else {
      const beforeUri = vscode.Uri.from({
        scheme: "git",
        path: fileUri.path,
        query: JSON.stringify({ path: absolutePath, ref: `${hash}~1` }),
      });
      const afterUri = vscode.Uri.from({
        scheme: "git",
        path: fileUri.path,
        query: JSON.stringify({ path: absolutePath, ref: hash }),
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        beforeUri,
        afterUri,
        `${filePath} (${hash.substring(0, 7)})`,
      );
    }
  }

  private async _sendLocalizedStrings(): Promise<void> {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({
      type: "setStrings",
      strings: {
        changes: vscode.l10n.t("Changes"),
        untrackedFiles: vscode.l10n.t("Untracked Files"),
        amend: vscode.l10n.t("Amend"),
        commitMessagePlaceholder: vscode.l10n.t("Enter commit message..."),
        commit: vscode.l10n.t("Commit"),
        push: vscode.l10n.t("Push"),
        forcePush: vscode.l10n.t("Force Push"),
        noChanges: vscode.l10n.t("No changes"),
        search: vscode.l10n.t("Search..."),
        selectAll: vscode.l10n.t("Select all"),
        deselectAll: vscode.l10n.t("Deselect all"),
        commitOverview: vscode.l10n.t("Commit Overview"),
        changedFiles: vscode.l10n.t("Changed Files"),
        unpushedCommits: vscode.l10n.t("Unpushed Commits"),
        noUpstreamBranch: vscode.l10n.t("No upstream branch configured"),
        allChangesPushed: vscode.l10n.t("All commits pushed"),
      },
    });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = getWebviewUri(webview, this._extensionUri, [
      "dist",
      "webview-ui",
      "commitChanges.js",
    ]);
    const styleUri = getWebviewUri(webview, this._extensionUri, [
      "dist",
      "webview-ui",
      "commitChanges.css",
    ]);

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <title>Commit Changes</title>
</head>
<body>
  <div id="changes-container">
    <div id="search-bar">
      <input type="text" id="search-input" placeholder="Search..." />
    </div>
    <div id="file-tree"></div>
    <div id="untracked-tree"></div>
  </div>

  <div id="unpushed-section" class="hidden">
    <div id="unpushed-header">
      <span id="unpushed-toggle" class="tree-arrow expanded">&#x25B6;</span>
      <span id="unpushed-label" class="section-label">Unpushed Commits (0)</span>
    </div>
    <div id="unpushed-list"></div>
  </div>

  <div id="commit-form">
    <div id="amend-row">
      <label>
        <input type="checkbox" id="amend-checkbox" />
        <span>Amend</span>
      </label>
    </div>
    <textarea id="commit-message" placeholder="Enter commit message..." rows="3"></textarea>
    <div id="button-row">
      <button id="commit-btn" class="primary" disabled>Commit</button>
      <button id="push-btn" class="secondary">Push</button>
      <button id="force-push-btn" class="secondary danger">Force Push</button>
      <button id="overview-btn" class="icon-btn" title="Commit Overview">
        <span class="codicon codicon-list-flat"></span>
      </button>
    </div>
  </div>

  <!-- Commit Overview Modal -->
  <div id="commit-overview-modal" class="hidden">
    <div id="modal-header">
      <span id="modal-title">Commit Overview</span>
      <button id="modal-close" class="icon-btn">&times;</button>
    </div>
    <div id="modal-body">
      <div id="modal-commit-list"></div>
      <div id="modal-commit-details" class="hidden"></div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this._onSelectCommitInGraph.dispose();
    this._disposables.forEach((d) => d.dispose());
  }
}
