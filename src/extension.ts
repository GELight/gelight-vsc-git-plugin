/**
 * Extension entry point — activates the GELight Git plugin.
 * Registers view providers, commands, and watchers.
 */
import * as vscode from "vscode";
import { GitService } from "./git/gitService";
import { GitCliService } from "./git/gitCliService";
import { GitWatcher } from "./git/gitWatcher";
import { GitGraphViewProvider } from "./views/gitGraph/GitGraphViewProvider";
import { CommitChangesViewProvider } from "./views/commitChanges/CommitChangesViewProvider";

// Stored context for webview context menu data
let _selectedCommitHash: string | undefined;
let _selectedCommitHashes: string[] = [];
let _selectedFilePath: string | undefined;

export function activate(context: vscode.ExtensionContext) {
  const gitService = new GitService();
  const gitWatcher = new GitWatcher(gitService);

  const gitGraphProvider = new GitGraphViewProvider(
    context.extensionUri,
    gitService,
    gitWatcher,
  );

  const commitChangesProvider = new CommitChangesViewProvider(
    context.extensionUri,
    gitService,
    gitWatcher,
  );

  // Register webview view providers
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GitGraphViewProvider.viewType,
      gitGraphProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CommitChangesViewProvider.viewType,
      commitChangesProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Register commands

  // --- Single commit context menu commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gelight.editCommitMessage",
      (ctx?: { webviewSection?: string; commitHash?: string }) => {
        const hash = ctx?.commitHash ?? _selectedCommitHash;
        if (hash) {
          gitGraphProvider.handleEditCommitMessage(hash);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gelight.deleteCommit",
      (ctx?: { webviewSection?: string; commitHash?: string }) => {
        const hash = ctx?.commitHash ?? _selectedCommitHash;
        if (hash) {
          gitGraphProvider.handleDeleteCommit(hash);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gelight.resetToCommit",
      (ctx?: { webviewSection?: string; commitHash?: string }) => {
        const hash = ctx?.commitHash ?? _selectedCommitHash;
        if (hash) {
          gitGraphProvider.handleResetToCommit(hash);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gelight.copyCommitHash",
      (ctx?: { webviewSection?: string; commitHash?: string }) => {
        const hash = ctx?.commitHash ?? _selectedCommitHash;
        if (hash) {
          vscode.env.clipboard.writeText(hash);
          vscode.window.showInformationMessage(
            `Copied: ${hash.substring(0, 7)}`,
          );
        }
      },
    ),
  );

  // --- Multi commit context menu commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gelight.fixup",
      (ctx?: { commitHashes?: string[] }) => {
        const hashes = ctx?.commitHashes ?? _selectedCommitHashes;
        if (hashes.length >= 2) {
          gitGraphProvider.handleFixup(hashes);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gelight.squash",
      (ctx?: { commitHashes?: string[] }) => {
        const hashes = ctx?.commitHashes ?? _selectedCommitHashes;
        if (hashes.length >= 2) {
          gitGraphProvider.handleSquash(hashes);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gelight.softReset",
      (ctx?: { commitHashes?: string[] }) => {
        const hashes = ctx?.commitHashes ?? _selectedCommitHashes;
        if (hashes.length > 0) {
          gitGraphProvider.handleSoftResetMultiple(hashes);
        }
      },
    ),
  );

  // --- File-level command ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gelight.softResetFileFromCommit",
      (ctx?: { commitHash?: string; filePath?: string }) => {
        const hash = ctx?.commitHash ?? _selectedCommitHash;
        const file = ctx?.filePath ?? _selectedFilePath;
        if (hash && file) {
          gitGraphProvider.handleSoftResetFileFromCommit(hash, file);
        }
      },
    ),
  );

  // --- General commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand("gelight.commit", () => {
      // Triggered via keyboard shortcut — delegate to webview
      // The actual commit logic is in CommitChangesViewProvider via messages
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gelight.push", async () => {
      const repoPath = gitService.getRepoPath();
      if (!repoPath) {
        vscode.window.showErrorMessage("No Git repository found.");
        return;
      }
      try {
        const cli = new GitCliService(repoPath);
        await cli.push();
        vscode.window.showInformationMessage("Push successful.");
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Push failed: ${errorMsg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gelight.forcePush", async () => {
      const repoPath = gitService.getRepoPath();
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
        const cli = new GitCliService(repoPath);
        await cli.forcePush();
        vscode.window.showInformationMessage("Force push successful.");
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Force push failed: ${errorMsg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gelight.openCommitOverview", () => {
      // Handled through webview message
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gelight.refreshGraph", () => {
      gitWatcher.forceUpdate();
    }),
  );

  // Register disposables
  context.subscriptions.push(
    gitService,
    gitWatcher,
    gitGraphProvider,
    commitChangesProvider,
  );

  // Wire cross-view communication: unpushed commit click → select in Git Graph
  context.subscriptions.push(
    commitChangesProvider.onSelectCommitInGraph((hash) => {
      gitGraphProvider.selectCommit(hash);
    }),
  );
}

export function deactivate() {
  // Cleanup handled by disposables
}
