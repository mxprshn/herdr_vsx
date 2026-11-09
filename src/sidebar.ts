// The Agents and Spaces panels: webviews drawing the model, sending clicks back as messages.
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { Model } from './model';

export type Message =
  | { type: 'ready' }
  | { type: 'open'; address: string }
  | { type: 'openFile'; file: string; space: string }
  | { type: 'selectSpace'; space: string }
  | { type: 'newTab'; space?: string; agent?: string }
  | { type: 'newSpace'; agent?: string }
  | { type: 'closeTab'; tab: string }
  | { type: 'closeAgentTab'; tab: string }
  | { type: 'gitSpace'; space: string; op: 'fetch' | 'pull' }
  | { type: 'newNote'; space: string }
  | { type: 'closeSpace'; space: string }
  | { type: 'pin'; address: string; pinned: boolean }
  | { type: 'duplicate'; address: string }
  | { type: 'rename'; address: string; name: string };

export class Sidebar implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private model?: Model;

  constructor(
    private extensionUri: vscode.Uri,
    readonly mode: 'agents' | 'spaces',
    private onMessage: (m: Message) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const codicons = vscode.Uri.joinPath(media, 'codicons');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const uri = (base: vscode.Uri, file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(base, file));
    const nonce = randomBytes(16).toString('base64');
    const csp = view.webview.cspSource;
    view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${csp}; font-src ${csp}; style-src ${csp}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri(codicons, 'codicon.css')}">
<link rel="stylesheet" href="${uri(media, 'sidebar.css')}">
</head>
<body data-mode="${this.mode}" data-logo="${uri(media, 'herdr.svg')}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
<div id="root"></div>
<script nonce="${nonce}" src="${uri(media, 'sidebar.js')}"></script>
</body>
</html>`;
    view.webview.onDidReceiveMessage((m: Message) => {
      if (m.type === 'ready') this.post();
      else this.onMessage(m);
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.post(); });
  }

  update(model: Model) {
    this.model = model;
    this.post();
  }

  set badge(badge: vscode.ViewBadge | undefined) {
    if (this.view) this.view.badge = badge;
  }

  /** The grey text after the view's name in its header. */
  set description(text: string | undefined) {
    if (this.view) this.view.description = text;
  }

  private post() {
    if (this.view?.visible && this.model) void this.view.webview.postMessage({ type: 'model', model: this.model });
  }
}
