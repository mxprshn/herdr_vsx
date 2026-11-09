// Files open in VS Code become tabs of the space whose project holds them, and leave it
// when their last editor tab closes. Only tabs this window added are ever removed: they
// carry `props.vscode` = this window's first folder, so files opened in herdr-app stay.
import * as vscode from 'vscode';
import * as path from 'path';
import { fileTabNode, files, State } from './state';

export class FileTabs {
  private timer?: NodeJS.Timeout;

  constructor(
    private state: () => State | undefined,
    private projectOf: (folder: string) => Promise<string | undefined>,
    private current: () => string | undefined,
    private owner: string,
  ) {}

  /** Editor tabs change in bursts (a preview replaced, a group closed): sync once they settle. */
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.sync().catch((e) => vscode.window.showErrorMessage(`Herdr: cannot update the space: ${e.message}`));
    }, 300);
  }

  dispose() { clearTimeout(this.timer); }

  private openFiles(): string[] {
    const paths = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => t.input)
      .filter((i): i is vscode.TabInputText => i instanceof vscode.TabInputText && i.uri.scheme === 'file')
      .map((i) => i.uri.fsPath);
    return [...new Set(paths)];
  }

  private async sync() {
    const s = this.state();
    if (!s) return;
    const roots = await Promise.all(s.spaces.map(async (sp) => ({ id: sp.id, root: await this.projectOf(s.spaceFolder(sp)) })));
    // A file goes to the current space when its project holds it, else to the space with the closest project.
    const spaceFor = (file: string) => {
      const holding = roots.filter((r) => r.root && file.startsWith(r.root + path.sep));
      return holding.find((r) => r.id === this.current())?.id
        ?? holding.sort((a, b) => b.root!.length - a.root!.length)[0]?.id;
    };
    const wanted = new Map<string, string>();
    for (const file of this.openFiles()) {
      const space = spaceFor(file);
      if (space) wanted.set(file, space);
    }
    await s.editDoc((doc) => {
      let changed = false;
      const emptied = new Set<string>();
      for (const sp of doc.spaces) {
        const before = (sp.tabs ?? []).length;
        sp.tabs = (sp.tabs ?? []).filter((t: any) => {
          const file = this.ours(t);
          return !file || wanted.get(file) === sp.id;
        });
        if (sp.tabs.length !== before) {
          changed = true;
          if (!sp.tabs.length) emptied.add(sp.id);
        }
      }
      // A space this left with no tabs closes, as when its last tab is closed in herdr.
      doc.spaces = doc.spaces.filter((sp: any) => !emptied.has(sp.id));
      for (const [file, id] of wanted) {
        const sp = doc.spaces.find((x: any) => x.id === id);
        if (!sp || sp.tabs.some((t: any) => files(t.root).includes(file))) continue;
        sp.tabs.push(fileTabNode(file, path.basename(file), this.owner));
        changed = true;
      }
      return changed;
    });
  }

  /** The file of a tab this window added, if it is one. */
  private ours(tab: any): string | undefined {
    const block = tab.root?.children?.length === 1 ? tab.root.children[0] : undefined;
    const props = block?.content?.props;
    return props?.vscode === this.owner && typeof props.file === 'string' ? props.file : undefined;
  }
}
