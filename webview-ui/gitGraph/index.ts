/**
 * Git Graph webview entry point.
 * Handles rendering of the commit graph, selection, search, and details panel.
 */

// Types mirrored from extension (webview can't import from extension code)
interface GraphRow {
  commit: GitCommit;
  column: number;
  color: string;
  lines: GraphLine[];
}

interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  fullMessage: string;
  authorName: string;
  authorEmail: string;
  date: string; // serialized as string
  parents: string[];
  tags: string[];
  refs: string[];
}

interface GraphLine {
  fromColumn: number;
  toColumn: number;
  color: string;
  type: "straight" | "merge-left" | "merge-right" | "fork-left" | "fork-right";
}

interface GitFileChange {
  path: string;
  originalPath?: string;
  status: string;
  staged: boolean;
}

interface Strings {
  [key: string]: string;
}

// --- VSCode API ---
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// --- State ---
let allRows: GraphRow[] = [];
let filteredRows: GraphRow[] = [];
let selectedHashes: Set<string> = new Set();
let strings: Strings = {};
let detailsCommit: GitCommit | null = null;
let detailsFiles: GitFileChange[] = [];

// --- Constants ---
const ROW_HEIGHT = 32;
const COLUMN_WIDTH = 16;
const DOT_RADIUS = 5;
const GRAPH_PADDING = 12;

// --- DOM References ---
const commitListEl = document.getElementById("commit-list")!;
const commitDetailsEl = document.getElementById("commit-details")!;
const emptyStateEl = document.getElementById("empty-state")!;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const graphContainer = document.getElementById("graph-container")!;
const resizeHandle = document.getElementById("resize-handle")!;

// --- Message handling ---
window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "updateCommits":
      allRows = msg.commits;
      applyFilter();
      break;
    case "updateCommitDetails":
      detailsCommit = msg.commit;
      detailsFiles = msg.files;
      renderDetails();
      break;
    case "setStrings":
      strings = msg.strings;
      updateStringPlaceholders();
      break;
    case "clearSelection":
      selectedHashes.clear();
      renderCommitList();
      hideDetails();
      break;
  }
});

// --- Search ---
searchInput.addEventListener("input", () => {
  applyFilter();
});

function applyFilter(): void {
  const query = searchInput.value.toLowerCase().trim();
  if (!query) {
    filteredRows = allRows;
  } else {
    filteredRows = allRows.filter((row) => {
      const c = row.commit;
      return (
        c.message.toLowerCase().includes(query) ||
        c.shortHash.toLowerCase().includes(query) ||
        c.hash.toLowerCase().includes(query) ||
        c.authorName.toLowerCase().includes(query) ||
        c.tags.some((t) => t.toLowerCase().includes(query))
      );
    });
  }
  renderCommitList();
}

function updateStringPlaceholders(): void {
  searchInput.placeholder = strings.search || "Search...";
  const noCommitsMsg = document.getElementById("no-commits-message");
  if (noCommitsMsg) {
    noCommitsMsg.textContent = strings.noCommits || "No commits found";
  }
}

// --- Render commit list ---
function renderCommitList(): void {
  if (filteredRows.length === 0) {
    commitListEl.classList.add("hidden");
    emptyStateEl.classList.remove("hidden");
    commitDetailsEl.classList.add("hidden");
    return;
  }

  emptyStateEl.classList.add("hidden");
  commitListEl.classList.remove("hidden");

  // Calculate max columns for graph width
  const maxColumns =
    Math.max(
      ...filteredRows.map((r) => {
        const lineCols = r.lines.map((l) => Math.max(l.fromColumn, l.toColumn));
        return Math.max(r.column, ...lineCols, 0);
      }),
      0,
    ) + 1;

  const graphWidth = maxColumns * COLUMN_WIDTH + GRAPH_PADDING * 2;

  commitListEl.innerHTML = "";

  // SVG for graph lines
  const svgNS = "http://www.w3.org/2000/svg";
  const totalHeight = filteredRows.length * ROW_HEIGHT;

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "graph-svg");
  svg.setAttribute("width", String(graphWidth));
  svg.setAttribute("height", String(totalHeight));
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";

  // Draw lines and dots
  filteredRows.forEach((row, index) => {
    const cy = index * ROW_HEIGHT + ROW_HEIGHT / 2;

    // Draw branch lines
    row.lines.forEach((line) => {
      const x1 = GRAPH_PADDING + line.fromColumn * COLUMN_WIDTH;
      const y1 = cy;
      const x2 = GRAPH_PADDING + line.toColumn * COLUMN_WIDTH;
      const y2 = cy + ROW_HEIGHT;

      if (line.type === "straight") {
        const pathEl = document.createElementNS(svgNS, "line");
        pathEl.setAttribute("x1", String(x1));
        pathEl.setAttribute("y1", String(y1));
        pathEl.setAttribute("x2", String(x2));
        pathEl.setAttribute("y2", String(y2));
        pathEl.setAttribute("stroke", line.color);
        pathEl.setAttribute("stroke-width", "2");
        svg.appendChild(pathEl);
      } else {
        // Curved lines for merges/forks
        const path = document.createElementNS(svgNS, "path");
        const midY = (y1 + y2) / 2;
        const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
        path.setAttribute("d", d);
        path.setAttribute("stroke", line.color);
        path.setAttribute("stroke-width", "2");
        path.setAttribute("fill", "none");
        svg.appendChild(path);
      }
    });

    // Draw commit dot
    const cx = GRAPH_PADDING + row.column * COLUMN_WIDTH;
    const circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", String(DOT_RADIUS));
    circle.setAttribute("fill", row.color);
    circle.setAttribute("stroke", "var(--vscode-editor-background)");
    circle.setAttribute("stroke-width", "2");
    svg.appendChild(circle);
  });

  // Create wrapper with relative positioning
  const listWrapper = document.createElement("div");
  listWrapper.className = "list-wrapper";
  listWrapper.style.position = "relative";
  listWrapper.style.minHeight = `${totalHeight}px`;

  listWrapper.appendChild(svg);

  // Draw commit rows
  filteredRows.forEach((row, index) => {
    const rowEl = document.createElement("div");
    rowEl.className = "commit-row";
    if (selectedHashes.has(row.commit.hash)) {
      rowEl.classList.add("selected");
    }
    rowEl.style.height = `${ROW_HEIGHT}px`;
    rowEl.style.paddingLeft = `${graphWidth + 8}px`;

    // Context data for VSCode context menus
    const isMulti =
      selectedHashes.size > 1 && selectedHashes.has(row.commit.hash);
    const contextSection = isMulti ? "multiCommit" : "singleCommit";

    const contextData: Record<string, unknown> = {
      webviewSection: contextSection,
      commitHash: row.commit.hash,
      preventDefaultContextMenuItems: true,
    };

    if (isMulti) {
      contextData.commitHashes = Array.from(selectedHashes);
    }

    rowEl.setAttribute("data-vscode-context", JSON.stringify(contextData));
    rowEl.dataset.hash = row.commit.hash;

    // Short hash (clickable to copy)
    const hashEl = document.createElement("span");
    hashEl.className = "commit-hash";
    hashEl.textContent = row.commit.shortHash;
    hashEl.title = "Click to copy";
    hashEl.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "copyHash", hash: row.commit.hash });
      hashEl.classList.add("copied");
      setTimeout(() => hashEl.classList.remove("copied"), 1000);
    });

    // Commit message
    const msgEl = document.createElement("span");
    msgEl.className = "commit-message";
    msgEl.textContent = row.commit.message;

    // Tags
    const tagsContainer = document.createElement("span");
    tagsContainer.className = "commit-tags";
    row.commit.tags.forEach((tag) => {
      const tagEl = document.createElement("span");
      tagEl.className = "tag-badge";
      tagEl.textContent = tag;
      tagsContainer.appendChild(tagEl);
    });

    // Refs (branch names)
    row.commit.refs.forEach((ref) => {
      const refEl = document.createElement("span");
      refEl.className = "ref-badge";
      refEl.textContent = ref;
      tagsContainer.appendChild(refEl);
    });

    // Author
    const authorEl = document.createElement("span");
    authorEl.className = "commit-author";
    authorEl.textContent = row.commit.authorName;

    // Date
    const dateEl = document.createElement("span");
    dateEl.className = "commit-date";
    dateEl.textContent = formatRelativeDate(row.commit.date);

    rowEl.appendChild(hashEl);
    rowEl.appendChild(msgEl);
    rowEl.appendChild(tagsContainer);
    rowEl.appendChild(authorEl);
    rowEl.appendChild(dateEl);

    // Click handler for selection
    rowEl.addEventListener("click", (e) => {
      handleCommitClick(row.commit.hash, e.shiftKey);
    });

    listWrapper.appendChild(rowEl);
  });

  commitListEl.appendChild(listWrapper);
}

// --- Selection ---
let lastClickedHash: string | null = null;

function handleCommitClick(hash: string, shiftKey: boolean): void {
  if (shiftKey && lastClickedHash) {
    // Range select
    const startIdx = filteredRows.findIndex(
      (r) => r.commit.hash === lastClickedHash,
    );
    const endIdx = filteredRows.findIndex((r) => r.commit.hash === hash);
    if (startIdx !== -1 && endIdx !== -1) {
      const from = Math.min(startIdx, endIdx);
      const to = Math.max(startIdx, endIdx);
      selectedHashes.clear();
      for (let i = from; i <= to; i++) {
        selectedHashes.add(filteredRows[i].commit.hash);
      }
    }
  } else {
    // Single select
    selectedHashes.clear();
    selectedHashes.add(hash);
    // Request details for this commit
    vscode.postMessage({ type: "requestCommitDetails", hash });
  }

  lastClickedHash = hash;
  renderCommitList();
  updateContextMenu();
}

function updateContextMenu(): void {
  // Update data-vscode-context on all rows based on current selection
  const rows = commitListEl.querySelectorAll(".commit-row");
  rows.forEach((rowEl) => {
    const hash = (rowEl as HTMLElement).dataset.hash;
    if (!hash) {
      return;
    }

    const isMulti = selectedHashes.size > 1 && selectedHashes.has(hash);
    const contextSection = isMulti ? "multiCommit" : "singleCommit";

    const contextData: Record<string, unknown> = {
      webviewSection: contextSection,
      commitHash: hash,
      preventDefaultContextMenuItems: true,
    };

    if (isMulti) {
      contextData.commitHashes = Array.from(selectedHashes);
    }

    rowEl.setAttribute("data-vscode-context", JSON.stringify(contextData));
  });
}

// --- Details panel ---
function renderDetails(): void {
  if (!detailsCommit) {
    hideDetails();
    return;
  }

  commitDetailsEl.classList.remove("hidden");
  resizeHandle.classList.remove("hidden");

  commitDetailsEl.innerHTML = `
    <div class="details-header">
      <h3>${strings.commitDetails || "Commit Details"}</h3>
      <button class="close-details" id="close-details">&times;</button>
    </div>
    <div class="details-body">
      <div class="detail-field">
        <span class="detail-label">${strings.commitDetails || "Hash"}:</span>
        <span class="detail-value hash-value">${detailsCommit.hash}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">${strings.author || "Author"}:</span>
        <span class="detail-value">${escapeHtml(detailsCommit.authorName)} &lt;${escapeHtml(detailsCommit.authorEmail)}&gt;</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">${strings.date || "Date"}:</span>
        <span class="detail-value">${new Date(detailsCommit.date).toLocaleString()}</span>
      </div>
      ${
        detailsCommit.parents.length > 0
          ? `
      <div class="detail-field">
        <span class="detail-label">${strings.parents || "Parents"}:</span>
        <span class="detail-value">${detailsCommit.parents.map((p) => p.substring(0, 7)).join(", ")}</span>
      </div>`
          : ""
      }
      ${
        detailsCommit.tags.length > 0
          ? `
      <div class="detail-field">
        <span class="detail-label">${strings.tags || "Tags"}:</span>
        <span class="detail-value">${detailsCommit.tags.map((t) => `<span class="tag-badge">${escapeHtml(t)}</span>`).join(" ")}</span>
      </div>`
          : ""
      }
      <div class="detail-field message-field">
        <span class="detail-label">Message:</span>
        <pre class="detail-value commit-full-message">${escapeHtml(detailsCommit.fullMessage)}</pre>
      </div>
      <div class="detail-section">
        <h4>${strings.changedFiles || "Changed Files"} (${detailsFiles.length})</h4>
        <div class="file-list">
          ${detailsFiles
            .map(
              (f) => `
            <div class="file-entry" data-vscode-context='${JSON.stringify({
              webviewSection: "commitFile",
              commitHash: detailsCommit!.hash,
              filePath: f.path,
              preventDefaultContextMenuItems: true,
            })}'>
              <span class="file-status status-${f.status}">${f.status}</span>
              <span class="file-path">${escapeHtml(f.path)}</span>
            </div>
          `,
            )
            .join("")}
        </div>
      </div>
    </div>
  `;

  // Bind close button
  document
    .getElementById("close-details")
    ?.addEventListener("click", hideDetails);
}

function hideDetails(): void {
  commitDetailsEl.classList.add("hidden");
  resizeHandle.classList.add("hidden");
  commitDetailsEl.innerHTML = "";
  detailsCommit = null;
  detailsFiles = [];
}

// --- Keyboard ---
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    selectedHashes.clear();
    lastClickedHash = null;
    renderCommitList();
    hideDetails();
  }
});

// --- Utility ---
function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) {
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return "just now";
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Resize handle logic ---
(function initResize() {
  let startX = 0;
  let startWidth = 0;

  function onMouseDown(e: MouseEvent): void {
    e.preventDefault();
    startX = e.clientX;
    startWidth = commitDetailsEl.offsetWidth;
    resizeHandle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e: MouseEvent): void {
    const delta = startX - e.clientX;
    const newWidth = Math.max(
      180,
      Math.min(startWidth + delta, graphContainer.offsetWidth - 200),
    );
    commitDetailsEl.style.width = `${newWidth}px`;
  }

  function onMouseUp(): void {
    resizeHandle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  resizeHandle.addEventListener("mousedown", onMouseDown);
})();

// --- Init ---
vscode.postMessage({ type: "ready" });
