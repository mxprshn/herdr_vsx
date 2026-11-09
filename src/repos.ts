// Per-folder git facts for the spaces list: is it a repo, and its GitHub owner's avatar.
// Avatars are shared with herdr-app's my-spaces mod (`my-icons/github/<owner>.png`).
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { RepoInfo } from './model';

/** The owner in an origin like https://github.com/o/r.git or git@github.com:o/r.git. */
function githubOwner(url: string): string | undefined {
  return /github\.com[:/]([A-Za-z0-9-]+)\/[^/\s]+?(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 15000 }, (e, out) => resolve({ code: e ? 1 : 0, out: String(out ?? '') }));
  });
}

export class Repos {
  private info = new Map<string, RepoInfo>();
  private asked = new Set<string>();
  private avatars = new Map<string, string | null>();

  constructor(private avatarDir: string, private changed: () => void) {}

  /** What is known now; asks git once per folder and calls `changed` when it learns more. */
  get(folder: string): RepoInfo | undefined {
    if (!folder) return undefined;
    if (!this.asked.has(folder)) {
      this.asked.add(folder);
      void this.look(folder);
    }
    return this.info.get(folder);
  }

  private async look(folder: string) {
    const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], folder);
    if (inside.code !== 0) return;
    const origin = await run('git', ['remote', 'get-url', 'origin'], folder);
    const owner = origin.code === 0 ? githubOwner(origin.out) : undefined;
    const avatar = owner ? await this.avatar(owner) : undefined;
    this.info.set(folder, { git: true, avatar, avatarFile: avatar ? path.join(this.avatarDir, `${owner}.png`) : undefined });
    this.changed();
  }

  private async avatar(owner: string): Promise<string | undefined> {
    if (this.avatars.has(owner)) return this.avatars.get(owner) ?? undefined;
    this.avatars.set(owner, null);
    const file = path.join(this.avatarDir, `${owner}.png`);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      fs.mkdirSync(this.avatarDir, { recursive: true });
      const r = await run('curl', ['-fsSL', '--max-time', '15', '-o', file, `https://github.com/${owner}.png?size=72`]);
      if (r.code !== 0) { fs.rmSync(file, { force: true }); return undefined; }
    }
    const uri = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    this.avatars.set(owner, uri);
    return uri;
  }

  forget(folder: string) {
    this.asked.delete(folder);
  }
}
