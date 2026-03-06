/**
 * Commit Changes webview entry point.
 * Handles file tree rendering, commit form, amend toggle, and commit overview modal.
 */

interface GitFileChange {
  path: string;
  originalPath?: string;
  status: string;
  staged: boolean;
}

interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileTreeNode[];
  change?: GitFileChange;
  checked: boolean;
  expanded: boolean;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  fullMessage: string;
  authorName: string;
  authorEmail: string;
  date: string;
  parents: string[];
  tags: string[];
  refs: string[];
}

interface GraphRow {
  commit: GitCommit;
  column: number;
  color: string;
  lines: { fromColumn: number; toColumn: number; color: string; type: string }[];
}

interface Strings { [key: string]: string; }

// --- VSCode API ---
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// --- State ---
let stagedChanges: GitFileChange[] = [];
let unstagedChanges: GitFileChange[] = [];
let untrackedFiles: GitFileChange[] = [];
let changesTree: FileTreeNode | null = null;
let untrackedTree: FileTreeNode | null = null;
let strings: Strings = {};
let isAmendMode = false;
let savedMessage = '';
let overviewCommits: GraphRow[] = [];
let overviewSelectedCommit: GitCommit | null = null;
let overviewFiles: GitFileChange[] = [];

// --- DOM References ---
const fileTreeEl = document.getElementById('file-tree')!;
const untrackedTreeEl = document.getElementById('untracked-tree')!;
const commitMessageEl = document.getElementById('commit-message') as HTMLTextAreaElement;
const commitBtn = document.getElementById('commit-btn') as HTMLButtonElement;
const pushBtn = document.getElementById('push-btn') as HTMLButtonElement;
const forcePushBtn = document.getElementById('force-push-btn') as HTMLButtonElement;
const overviewBtn = document.getElementById('overview-btn') as HTMLButtonElement;
const amendCheckbox = document.getElementById('amend-checkbox') as HTMLInputElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const modalEl = document.getElementById('commit-overview-modal')!;
const modalCloseBtn = document.getElementById('modal-close')!;
const modalCommitList = document.getElementById('modal-commit-list')!;
const modalCommitDetails = document.getElementById('modal-commit-details')!;

// --- Message handling ---
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'updateChanges':
      stagedChanges = msg.staged;
      unstagedChanges = msg.unstaged;
      untrackedFiles = msg.untracked;
      rebuildTrees();
      renderAll();
      updateCommitButton();
      break;
    case 'updateHeadMessage':
      if (isAmendMode) {
        commitMessageEl.value = msg.message;
      }
      break;
    case 'operationComplete':
      if (msg.operation === 'commit' && msg.success) {
        commitMessageEl.value = '';
        savedMessage = '';
        if (isAmendMode) {
          isAmendMode = false;
          amendCheckbox.checked = false;
        }
      }
      break;
    case 'setStrings':
      strings = msg.strings;
      updateStringPlaceholders();
      break;
    case 'updateCommits':
      overviewCommits = msg.commits;
      renderOverviewCommitList();
      break;
    case 'updateCommitDetails':
      overviewSelectedCommit = msg.commit;
      overviewFiles = msg.files;
      renderOverviewDetails();
      break;
  }
});

function updateStringPlaceholders(): void {
  commitMessageEl.placeholder = strings.commitMessagePlaceholder || 'Enter commit message...';
  searchInput.placeholder = strings.search || 'Search...';
  commitBtn.textContent = strings.commit || 'Commit';
  pushBtn.textContent = strings.push || 'Push';
  forcePushBtn.textContent = strings.forcePush || 'Force Push';
  const amendLabel = amendCheckbox.parentElement?.querySelector('span');
  if (amendLabel) { amendLabel.textContent = strings.amend || 'Amend'; }
  const modalTitle = document.getElementById('modal-title');
  if (modalTitle) { modalTitle.textContent = strings.commitOverview || 'Commit Overview'; }
}

// --- File Tree Building ---
function rebuildTrees(): void {
  const allChanges = [...stagedChanges, ...unstagedChanges];
  changesTree = buildTree(allChanges, strings.changes || 'Changes');
  untrackedTree = buildTree(untrackedFiles, strings.untrackedFiles || 'Untracked Files');
}

function buildTree(files: GitFileChange[], rootName: string): FileTreeNode {
  const root: FileTreeNode = {
    name: rootName,
    path: '',
    isDirectory: true,
    children: [],
    checked: false,
    expanded: true,
  };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const partPath = parts.slice(0, i + 1).join('/');

      if (isFile) {
        current.children.push({
          name: part,
          path: file.path,
          isDirectory: false,
          children: [],
          change: file,
          checked: file.staged,
          expanded: false,
        });
      } else {
        let dirNode = current.children.find(c => c.isDirectory && c.name === part);
        if (!dirNode) {
          dirNode = {
            name: part,
            path: partPath,
            isDirectory: true,
            children: [],
            checked: false,
            expanded: true,
          };
          current.children.push(dirNode);
        }
        current = dirNode;
      }
    }
  }

  // Update directory checked states
  updateDirectoryCheckedState(root);
  return root;
}

function updateDirectoryCheckedState(node: FileTreeNode): void {
  if (!node.isDirectory) { return; }
  node.children.forEach(child => updateDirectoryCheckedState(child));
  const fileChildren = getAllFiles(node);
  node.checked = fileChildren.length > 0 && fileChildren.every(f => f.checked);
}

function getAllFiles(node: FileTreeNode): FileTreeNode[] {
  if (!node.isDirectory) { return [node]; }
  return node.children.flatMap(c => getAllFiles(c));
}

// --- Rendering ---
function renderAll(): void {
  renderTree(fileTreeEl, changesTree, 'changes');
  renderTree(untrackedTreeEl, untrackedTree, 'untracked');
}

function renderTree(container: HTMLElement, tree: FileTreeNode | null, section: string): void {
  container.innerHTML = '';
  if (!tree || tree.children.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-tree';
    emptyEl.textContent = strings.noChanges || 'No changes';
    container.appendChild(emptyEl);
    return;
  }

  // Section header
  const header = document.createElement('div');
  header.className = 'tree-section-header';

  const headerCheckbox = document.createElement('input');
  headerCheckbox.type = 'checkbox';
  headerCheckbox.checked = tree.checked;
  headerCheckbox.addEventListener('change', () => {
    toggleAllFiles(tree, headerCheckbox.checked);
    renderAll();
    updateCommitButton();
  });

  const headerLabel = document.createElement('span');
  headerLabel.className = 'section-label';
  headerLabel.textContent = `${tree.name} (${getAllFiles(tree).length})`;

  header.appendChild(headerCheckbox);
  header.appendChild(headerLabel);
  container.appendChild(header);

  // Render children
  const filterQuery = searchInput.value.toLowerCase().trim();
  renderTreeNodes(container, tree.children, 0, filterQuery);
}

function renderTreeNodes(container: HTMLElement, nodes: FileTreeNode[], depth: number, filter: string): void {
  for (const node of nodes) {
    if (filter && !nodeMatchesFilter(node, filter)) { continue; }

    const rowEl = document.createElement('div');
    rowEl.className = `tree-row ${node.isDirectory ? 'tree-dir' : 'tree-file'}`;
    rowEl.style.paddingLeft = `${12 + depth * 16}px`;

    if (node.isDirectory) {
      // Expand/collapse arrow
      const arrow = document.createElement('span');
      arrow.className = `tree-arrow ${node.expanded ? 'expanded' : ''}`;
      arrow.textContent = '▶';
      arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        node.expanded = !node.expanded;
        renderAll();
      });
      rowEl.appendChild(arrow);
    }

    // Checkbox
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = node.checked;
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (node.isDirectory) {
        toggleAllFiles(node, checkbox.checked);
      } else {
        node.checked = checkbox.checked;
      }
      if (changesTree) { updateDirectoryCheckedState(changesTree); }
      if (untrackedTree) { updateDirectoryCheckedState(untrackedTree); }
      renderAll();
      updateCommitButton();
    });
    rowEl.appendChild(checkbox);

    // Status icon (for files)
    if (!node.isDirectory && node.change) {
      const statusEl = document.createElement('span');
      statusEl.className = `file-status status-${node.change.status}`;
      statusEl.textContent = node.change.status;
      rowEl.appendChild(statusEl);
    }

    // Name
    const nameEl = document.createElement('span');
    nameEl.className = 'tree-name';
    nameEl.textContent = node.name;
    rowEl.appendChild(nameEl);

    container.appendChild(rowEl);

    // Render children if expanded directory
    if (node.isDirectory && node.expanded) {
      renderTreeNodes(container, node.children, depth + 1, filter);
    }
  }
}

function nodeMatchesFilter(node: FileTreeNode, filter: string): boolean {
  if (!node.isDirectory) {
    return node.path.toLowerCase().includes(filter) || node.name.toLowerCase().includes(filter);
  }
  return node.children.some(c => nodeMatchesFilter(c, filter));
}

function toggleAllFiles(node: FileTreeNode, checked: boolean): void {
  if (!node.isDirectory) {
    node.checked = checked;
    return;
  }
  node.children.forEach(c => toggleAllFiles(c, checked));
  node.checked = checked;
}

function getCheckedFiles(): string[] {
  const files: string[] = [];
  if (changesTree) { collectCheckedFiles(changesTree, files); }
  if (untrackedTree) { collectCheckedFiles(untrackedTree, files); }
  return files;
}

function collectCheckedFiles(node: FileTreeNode, files: string[]): void {
  if (!node.isDirectory && node.checked) {
    files.push(node.path);
  }
  node.children.forEach(c => collectCheckedFiles(c, files));
}

// --- Commit form ---
function updateCommitButton(): void {
  const hasFiles = getCheckedFiles().length > 0;
  const hasMessage = commitMessageEl.value.trim().length > 0 || isAmendMode;
  commitBtn.disabled = !(hasFiles && hasMessage);
}

commitMessageEl.addEventListener('input', () => {
  if (!isAmendMode) {
    savedMessage = commitMessageEl.value;
  }
  updateCommitButton();
});

commitBtn.addEventListener('click', () => {
  const files = getCheckedFiles();
  const message = commitMessageEl.value.trim();
  if (files.length === 0) { return; }
  vscode.postMessage({
    type: 'commit',
    message,
    amend: isAmendMode,
    files,
  });
});

pushBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'push' });
});

forcePushBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'forcePush' });
});

// --- Amend ---
amendCheckbox.addEventListener('change', () => {
  isAmendMode = amendCheckbox.checked;
  if (isAmendMode) {
    savedMessage = commitMessageEl.value;
    vscode.postMessage({ type: 'toggleAmend', enabled: true });
  } else {
    commitMessageEl.value = savedMessage;
  }
  updateCommitButton();
});

// --- Search ---
searchInput.addEventListener('input', () => {
  renderAll();
});

// --- Commit Overview Modal ---
overviewBtn.addEventListener('click', () => {
  modalEl.classList.remove('hidden');
  vscode.postMessage({ type: 'openCommitOverview' });
});

modalCloseBtn.addEventListener('click', () => {
  modalEl.classList.add('hidden');
  overviewSelectedCommit = null;
  overviewFiles = [];
  modalCommitDetails.classList.add('hidden');
});

function renderOverviewCommitList(): void {
  modalCommitList.innerHTML = '';

  for (const row of overviewCommits) {
    const commitEl = document.createElement('div');
    commitEl.className = 'modal-commit-row';
    commitEl.dataset.hash = row.commit.hash;

    const hashEl = document.createElement('span');
    hashEl.className = 'modal-commit-hash';
    hashEl.textContent = row.commit.shortHash;

    const msgEl = document.createElement('span');
    msgEl.className = 'modal-commit-msg';
    msgEl.textContent = row.commit.message;

    commitEl.appendChild(hashEl);
    commitEl.appendChild(msgEl);

    commitEl.addEventListener('click', () => {
      // Highlight selected
      modalCommitList.querySelectorAll('.modal-commit-row').forEach(el => el.classList.remove('selected'));
      commitEl.classList.add('selected');
      // Request details
      vscode.postMessage({ type: 'requestCommitDetails', hash: row.commit.hash });
    });

    modalCommitList.appendChild(commitEl);
  }
}

function renderOverviewDetails(): void {
  if (!overviewSelectedCommit) {
    modalCommitDetails.classList.add('hidden');
    return;
  }

  modalCommitDetails.classList.remove('hidden');
  modalCommitDetails.innerHTML = `
    <div class="modal-detail-header">
      <span class="modal-detail-hash">${overviewSelectedCommit.shortHash}</span>
      <span class="modal-detail-msg">${escapeHtml(overviewSelectedCommit.message)}</span>
    </div>
    <div class="modal-file-list">
      ${overviewFiles.map(f => `
        <div class="modal-file-entry">
          <span class="file-status status-${f.status}">${f.status}</span>
          <span class="file-path">${escapeHtml(f.path)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// --- Keyboard ---
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!modalEl.classList.contains('hidden')) {
      modalEl.classList.add('hidden');
    }
  }
  // Ctrl/Cmd+Enter to commit from message field
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement === commitMessageEl) {
    if (!commitBtn.disabled) {
      commitBtn.click();
    }
  }
});

// Modal resizable (basic drag handle via CSS resize)
// The modal uses CSS `resize: both` for simplicity

// --- Utility ---
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---
vscode.postMessage({ type: 'ready' });
