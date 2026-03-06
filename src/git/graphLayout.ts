/**
 * Graph layout engine — calculates column positions and line paths
 * for git commit visualization.
 */
import { GitCommit, GraphRow, GraphLine } from './gitTypes';
import { GRAPH_COLORS } from '../utils/helpers';

/**
 * Calculate graph layout from a list of commits.
 * Assigns column positions to each commit and computes connecting lines.
 */
export function calculateGraphLayout(commits: GitCommit[]): GraphRow[] {
  if (commits.length === 0) { return []; }

  const rows: GraphRow[] = [];

  // Active branches: maps commit hash -> column index
  // Each "lane" is a branch line continuing down the graph
  let activeLanes: (string | null)[] = [];

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const lines: GraphLine[] = [];

    // Find if this commit is expected in any lane
    let commitColumn = activeLanes.indexOf(commit.hash);
    if (commitColumn === -1) {
      // New branch — find first empty lane or create new one
      commitColumn = activeLanes.indexOf(null);
      if (commitColumn === -1) {
        commitColumn = activeLanes.length;
        activeLanes.push(null);
      }
    }

    // This commit now occupies its column
    activeLanes[commitColumn] = null;

    // Draw continuing lines for all active lanes
    for (let col = 0; col < activeLanes.length; col++) {
      if (activeLanes[col] !== null && col !== commitColumn) {
        lines.push({
          fromColumn: col,
          toColumn: col,
          color: GRAPH_COLORS[col % GRAPH_COLORS.length],
          type: 'straight',
        });
      }
    }

    // Process parents
    const parents = commit.parents;
    if (parents.length > 0) {
      // First parent continues in the same column
      const firstParent = parents[0];
      const existingLane = activeLanes.indexOf(firstParent);
      if (existingLane !== -1 && existingLane !== commitColumn) {
        // Merge: this commit's first parent is already tracked in another lane
        lines.push({
          fromColumn: commitColumn,
          toColumn: existingLane,
          color: GRAPH_COLORS[commitColumn % GRAPH_COLORS.length],
          type: commitColumn > existingLane ? 'merge-left' : 'merge-right',
        });
      } else if (existingLane === -1) {
        // Continue first parent in the same column
        activeLanes[commitColumn] = firstParent;
        lines.push({
          fromColumn: commitColumn,
          toColumn: commitColumn,
          color: GRAPH_COLORS[commitColumn % GRAPH_COLORS.length],
          type: 'straight',
        });
      }

      // Additional parents (merge commits) branch out
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        const parentLane = activeLanes.indexOf(parentHash);

        if (parentLane !== -1) {
          // Parent already tracked — draw a merge line to it
          lines.push({
            fromColumn: commitColumn,
            toColumn: parentLane,
            color: GRAPH_COLORS[parentLane % GRAPH_COLORS.length],
            type: commitColumn > parentLane ? 'merge-left' : 'merge-right',
          });
        } else {
          // Need a new lane for this parent
          let newCol = activeLanes.indexOf(null);
          if (newCol === -1) {
            newCol = activeLanes.length;
            activeLanes.push(null);
          }
          activeLanes[newCol] = parentHash;
          lines.push({
            fromColumn: commitColumn,
            toColumn: newCol,
            color: GRAPH_COLORS[newCol % GRAPH_COLORS.length],
            type: commitColumn > newCol ? 'fork-left' : 'fork-right',
          });
        }
      }
    }

    // Clean up trailing null lanes
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }

    rows.push({
      commit,
      column: commitColumn,
      color: GRAPH_COLORS[commitColumn % GRAPH_COLORS.length],
      lines,
    });
  }

  return rows;
}
