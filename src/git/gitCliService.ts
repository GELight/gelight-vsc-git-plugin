/**
 * Git CLI service for advanced operations not available in the VSCode Git Extension API.
 * Uses child_process.execFile for direct git command execution.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { GitFileChange, FileChangeStatus } from "./gitTypes";

const execFileAsync = promisify(execFile);

export class GitCliService {
  constructor(private readonly repoPath: string) {}

  /**
   * Execute a git command in the repository directory.
   */
  private async _exec(
    args: string[],
    env?: Record<string, string>,
  ): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.repoPath,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  }

  /**
   * Stage files for commit.
   */
  public async stageFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    await this._exec(["add", "--", ...paths]);
  }

  /**
   * Commit staged changes.
   */
  public async commit(message: string, amend: boolean = false): Promise<void> {
    const args = ["commit"];
    if (amend) {
      args.push("--amend");
    }
    if (message) {
      args.push("-m", message);
    } else if (amend) {
      args.push("--no-edit");
    }
    await this._exec(args);
  }

  /**
   * Check if the working tree is clean (no uncommitted changes).
   */
  public async isWorkingTreeClean(): Promise<boolean> {
    const status = await this._exec(["status", "--porcelain"]);
    return status.length === 0;
  }

  /**
   * Get files changed in a specific commit.
   */
  public async getCommitFiles(hash: string): Promise<GitFileChange[]> {
    const output = await this._exec([
      "diff-tree",
      "--no-commit-id",
      "-r",
      "--name-status",
      hash,
    ]);

    if (!output) {
      return [];
    }

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        const statusChar = parts[0]?.[0] ?? "M";
        let filePath = parts[1] ?? "";
        let originalPath: string | undefined;

        if (statusChar === "R" || statusChar === "C") {
          originalPath = parts[1];
          filePath = parts[2] ?? "";
        }

        return {
          path: filePath,
          originalPath,
          status: this._mapStatusChar(statusChar),
          staged: true,
        };
      });
  }

  /**
   * Get commits that are ahead of the upstream branch (unpushed).
   */
  public async getUnpushedCommits(): Promise<
    {
      hash: string;
      shortHash: string;
      message: string;
      authorName: string;
      date: string;
    }[]
  > {
    try {
      const output = await this._exec([
        "log",
        "@{u}..HEAD",
        "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI",
      ]);
      if (!output) {
        return [];
      }
      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, shortHash, message, authorName, date] =
            line.split("\x1f");
          return {
            hash: hash ?? "",
            shortHash: shortHash ?? "",
            message: message ?? "",
            authorName: authorName ?? "",
            date: date ?? "",
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Soft reset to a specific commit.
   */
  public async softReset(commitHash: string): Promise<void> {
    await this._exec(["reset", "--soft", commitHash]);
  }

  /**
   * Edit the commit message of a specific commit via interactive rebase.
   */
  public async editCommitMessage(
    commitHash: string,
    newMessage: string,
  ): Promise<void> {
    // For HEAD commit, use amend directly
    const headHash = await this._exec(["rev-parse", "HEAD"]);
    if (
      headHash.startsWith(commitHash) ||
      commitHash.startsWith(headHash.substring(0, 7))
    ) {
      await this._exec(["commit", "--amend", "-m", newMessage]);
      return;
    }

    // For older commits, use interactive rebase with GIT_SEQUENCE_EDITOR
    const shortHash = commitHash.substring(0, 7);
    const seqEditor = this._createTempScript(
      `sed -i "s/^pick ${shortHash}/reword ${shortHash}/" "$1"`,
    );
    const msgEditor = this._createTempScript(
      `echo ${this._shellEscape(newMessage)} > "$1"`,
    );

    try {
      await this._exec(["rebase", "-i", `${commitHash}^`], {
        GIT_SEQUENCE_EDITOR: seqEditor,
        GIT_EDITOR: msgEditor,
      });
    } finally {
      this._cleanupTempScript(seqEditor);
      this._cleanupTempScript(msgEditor);
    }
  }

  /**
   * Delete a commit via interactive rebase (drop).
   */
  public async deleteCommit(commitHash: string): Promise<void> {
    const shortHash = commitHash.substring(0, 7);
    const seqEditor = this._createTempScript(
      `sed -i "/^pick ${shortHash}/d" "$1"`,
    );

    try {
      await this._exec(["rebase", "-i", `${commitHash}^`], {
        GIT_SEQUENCE_EDITOR: seqEditor,
      });
    } finally {
      this._cleanupTempScript(seqEditor);
    }
  }

  /**
   * Fixup: Combine selected commits into the oldest one (discard messages).
   * @param commitHashes Array of commit hashes, ordered oldest to newest.
   */
  public async fixup(commitHashes: string[]): Promise<void> {
    if (commitHashes.length < 2) {
      return;
    }

    const baseHash = commitHashes[0];
    const fixupHashes = commitHashes.slice(1).map((h) => h.substring(0, 7));

    const sedCommands = fixupHashes
      .map((h) => `s/^pick ${h}/fixup ${h}/`)
      .join("; ");

    const seqEditor = this._createTempScript(`sed -i '${sedCommands}' "$1"`);

    try {
      await this._exec(["rebase", "-i", `${baseHash}^`], {
        GIT_SEQUENCE_EDITOR: seqEditor,
      });
    } finally {
      this._cleanupTempScript(seqEditor);
    }
  }

  /**
   * Squash: Combine selected commits, merging their messages.
   * @param commitHashes Array of commit hashes, ordered oldest to newest.
   * @param message Optional custom squash message.
   */
  public async squash(commitHashes: string[], message?: string): Promise<void> {
    if (commitHashes.length < 2) {
      return;
    }

    const baseHash = commitHashes[0];
    const squashHashes = commitHashes.slice(1).map((h) => h.substring(0, 7));

    const sedCommands = squashHashes
      .map((h) => `s/^pick ${h}/squash ${h}/`)
      .join("; ");

    const seqEditor = this._createTempScript(`sed -i '${sedCommands}' "$1"`);

    const env: Record<string, string> = {
      GIT_SEQUENCE_EDITOR: seqEditor,
    };

    // If a custom message is provided, override the editor for the squash message
    if (message !== undefined) {
      const msgEditor = this._createTempScript(
        `echo ${this._shellEscape(message)} > "$1"`,
      );
      env.GIT_EDITOR = msgEditor;
    }

    try {
      await this._exec(["rebase", "-i", `${baseHash}^`], env);
    } finally {
      this._cleanupTempScript(seqEditor);
      if (env.GIT_EDITOR) {
        this._cleanupTempScript(env.GIT_EDITOR);
      }
    }
  }

  /**
   * Soft-reset files from a specific commit back to working tree.
   * For HEAD: reset the file and amend the commit.
   * For older commits: requires interactive rebase.
   */
  public async softResetFileFromCommit(
    commitHash: string,
    filePath: string,
  ): Promise<void> {
    const headHash = await this._exec(["rev-parse", "HEAD"]);
    const isHead =
      headHash.startsWith(commitHash) ||
      commitHash.startsWith(headHash.substring(0, 7));

    if (isHead) {
      // Reset the file from HEAD back to staged area, then amend
      await this._exec(["reset", "HEAD~", "--", filePath]);
      await this._exec(["commit", "--amend", "--no-edit"]);
    } else {
      // For older commits, this is more complex — use interactive rebase
      // with an exec command that removes the file from the commit
      const shortHash = commitHash.substring(0, 7);
      const seqEditor = this._createTempScript(
        `sed -i "s/^pick ${shortHash}/edit ${shortHash}/" "$1"`,
      );

      try {
        await this._exec(["rebase", "-i", `${commitHash}^`], {
          GIT_SEQUENCE_EDITOR: seqEditor,
        });
        // Now we're in the middle of the rebase, at the target commit
        await this._exec(["reset", "HEAD~", "--", filePath]);
        await this._exec(["commit", "--amend", "--no-edit"]);
        await this._exec(["rebase", "--continue"]);
      } finally {
        this._cleanupTempScript(seqEditor);
      }
    }
  }

  /**
   * Abort an ongoing rebase.
   */
  public async abortRebase(): Promise<void> {
    await this._exec(["rebase", "--abort"]);
  }

  /**
   * Check if a rebase is in progress.
   */
  public async isRebaseInProgress(): Promise<boolean> {
    try {
      const gitDir = await this._exec(["rev-parse", "--git-dir"]);
      const rebaseMergePath = path.join(this.repoPath, gitDir, "rebase-merge");
      const rebaseApplyPath = path.join(this.repoPath, gitDir, "rebase-apply");
      return fs.existsSync(rebaseMergePath) || fs.existsSync(rebaseApplyPath);
    } catch {
      return false;
    }
  }

  /**
   * Get all tags.
   */
  public async getTags(): Promise<Map<string, string[]>> {
    const output = await this._exec([
      "tag",
      "-l",
      "--format=%(objectname:short) %(refname:short)",
    ]);
    const tagMap = new Map<string, string[]>();

    if (!output) {
      return tagMap;
    }

    for (const line of output.split("\n").filter(Boolean)) {
      const [hash, tagName] = line.split(" ", 2);
      if (hash && tagName) {
        const existing = tagMap.get(hash) ?? [];
        existing.push(tagName);
        tagMap.set(hash, existing);
      }
    }
    return tagMap;
  }

  private _mapStatusChar(char: string): FileChangeStatus {
    switch (char) {
      case "A":
        return FileChangeStatus.Added;
      case "D":
        return FileChangeStatus.Deleted;
      case "R":
        return FileChangeStatus.Renamed;
      case "C":
        return FileChangeStatus.Copied;
      case "M":
      default:
        return FileChangeStatus.Modified;
    }
  }

  /**
   * Create a temporary shell script and return its path.
   */
  private _createTempScript(content: string): string {
    const tmpDir = os.tmpdir();
    const scriptPath = path.join(
      tmpDir,
      `gelight-git-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
    );
    fs.writeFileSync(scriptPath, `#!/bin/sh\n${content}\n`, { mode: 0o755 });
    return scriptPath;
  }

  /**
   * Remove a temporary script file.
   */
  private _cleanupTempScript(scriptPath: string): void {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Escape a string for safe use in shell scripts.
   */
  private _shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`;
  }
}
