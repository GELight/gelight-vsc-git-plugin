/**
 * Utility functions for the GELight Git extension.
 */
import * as vscode from 'vscode';

/**
 * Generate a cryptographic nonce for CSP in webviews.
 */
export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Get the webview URI for a file within the extension.
 */
export function getWebviewUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  pathSegments: string[]
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...pathSegments));
}

/**
 * Format a date for display.
 */
export function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) {
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  if (days > 0) { return `${days}d ago`; }
  if (hours > 0) { return `${hours}h ago`; }
  if (minutes > 0) { return `${minutes}m ago`; }
  return 'just now';
}

/**
 * Colors palette for git graph branch lines.
 */
export const GRAPH_COLORS = [
  '#4EC9B0', // teal
  '#CE9178', // salmon
  '#569CD6', // blue
  '#DCDCAA', // yellow
  '#C586C0', // purple
  '#D7BA7D', // gold
  '#9CDCFE', // light blue
  '#F44747', // red
  '#B5CEA8', // green
  '#D4D4D4', // gray
];
