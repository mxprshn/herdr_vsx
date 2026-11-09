// Shows the current space's project as an extra Explorer root, named `<space> · herdr`.
// The window's own folder stays first: changing the first root restarts every extension.
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/** Our root is found by its name, not remembered: adding a second root to a folder window
 * turns it into a new (untitled) workspace and restarts extensions with fresh state. */
const SUFFIX = ' · herdr';

function gitTop(folder: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd: folder, timeout: 5000 }, (e, out) => {
      resolve(e ? undefined : String(out).trim() || undefined);
    });
  });
}

export class ExplorerFollower {
  private wanted?: { folder: string; name: string };
  private busy = false;
  private tops = new Map<string, string>();

  /** Shows this space's project; a space that has none to show (home, `/`) clears ours. */
  follow(folder: string, name: string) {
    this.wanted = { folder, name };
    void this.drain();
  }

  /** The project a folder belongs to: its git repo, so a `cd` into a subfolder doesn't move the root. */
  async project(folder: string): Promise<string | undefined> {
    if (!folder) return undefined;
    let top = this.tops.get(folder);
    if (!top) {
      top = (await gitTop(folder)) ?? folder;
      this.tops.set(folder, top);
    }
    // Watching the whole home folder or disk would make the Explorer and search crawl.
    return top === os.homedir() || top === path.parse(top).root ? undefined : top;
  }

  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.wanted) {
        const { folder, name } = this.wanted;
        this.wanted = undefined;
        await this.show(await this.project(folder), name + SUFFIX);
      }
    } finally {
      this.busy = false;
    }
  }

  private async show(project: string | undefined, name: string) {
    let folders = vscode.workspace.workspaceFolders ?? [];
    // An empty window: adding a folder would reopen it as that folder.
    if (!folders.length) return;
    // Ours, last first; extra ones left by an older version go.
    const ours = folders.map((f, i) => i).filter((i) => i > 0 && folders[i].name.endsWith(SUFFIX)).reverse();
    for (const i of ours.slice(0, -1)) await this.update(i, 1);
    folders = vscode.workspace.workspaceFolders ?? [];
    const at = folders.findIndex((f, i) => i > 0 && f.name.endsWith(SUFFIX));
    const shownElsewhere = project && folders.some((f, i) => i !== at && f.uri.fsPath === project);
    if (!project || shownElsewhere) {
      if (at > 0) await this.update(at, 1);
      return;
    }
    if (at > 0 && folders[at].uri.fsPath === project && folders[at].name === name) return;
    const entry = { uri: vscode.Uri.file(project), name };
    await (at > 0 ? this.update(at, 1, entry) : this.update(folders.length, 0, entry));
  }

  private update(start: number, remove: number, ...add: { uri: vscode.Uri; name: string }[]): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { sub.dispose(); clearTimeout(timer); resolve(); };
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(done);
      const timer = setTimeout(done, 3000);
      if (!vscode.workspace.updateWorkspaceFolders(start, remove, ...add)) done();
    });
  }
}
