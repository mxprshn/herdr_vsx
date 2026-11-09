// macOS banners for agents: the agent's icon, the repo's avatar, what the agent just said,
// and a click that opens that agent in VS Code. Needs terminal-notifier; without it, a
// plain AppleScript banner (no icons, no click).
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

export interface Banner {
  /** One banner per agent: a newer one replaces it, opening the agent removes it. */
  group: string;
  title: string;
  subtitle: string;
  message: string;
  /** PNG shown big on the right. */
  image?: string;
  /** Icon on the left (SVG or PNG); macOS may ignore it. */
  icon?: string;
  /** Opened on click. */
  url: string;
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 10000 }, (e, out) => resolve({ ok: !e, out: String(out ?? '') })));
}

export class Notifier {
  private tool?: Promise<string | undefined>;
  private pngs = new Map<string, Promise<string | undefined>>();

  constructor(private cacheDir: string) {}

  private notifier(): Promise<string | undefined> {
    this.tool ??= (async () => {
      for (const p of ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier']) if (fs.existsSync(p)) return p;
      const r = await run('sh', ['-lc', 'command -v terminal-notifier']);
      return r.ok ? r.out.trim() || undefined : undefined;
    })();
    return this.tool;
  }

  /**
   * The banner's picture: rounded and inset in a transparent square, since macOS draws it
   * edge to edge in the banner's corner, where a bare square avatar rides over the edge.
   */
  private framed(file: string | undefined): Promise<string | undefined> {
    if (!file || !fs.existsSync(file)) return Promise.resolve(undefined);
    let p = this.pngs.get(`framed:${file}`);
    if (!p) {
      p = (async () => {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        const out = path.join(this.cacheDir, `framed-${path.basename(file, path.extname(file))}.png`);
        if (!fs.existsSync(out)) await run('osascript', ['-l', 'JavaScript', '-e', FRAME_SCRIPT, file, out]);
        return fs.existsSync(out) ? out : file;
      })();
      this.pngs.set(`framed:${file}`, p);
    }
    return p;
  }

  /** Notification images must be bitmaps: SVG icons are rendered once with Quick Look. */
  private png(file: string | undefined): Promise<string | undefined> {
    if (!file) return Promise.resolve(undefined);
    if (!file.endsWith('.svg')) return Promise.resolve(fs.existsSync(file) ? file : undefined);
    let p = this.pngs.get(file);
    if (!p) {
      p = (async () => {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        const out = path.join(this.cacheDir, `${path.basename(file)}.png`);
        if (!fs.existsSync(out)) await run('qlmanage', ['-t', '-s', '256', '-o', this.cacheDir, file]);
        return fs.existsSync(out) ? out : undefined;
      })();
      this.pngs.set(file, p);
    }
    return p;
  }

  async show(b: Banner) {
    if (process.platform !== 'darwin') return;
    const tool = await this.notifier();
    if (!tool) {
      const text = [b.subtitle, b.message].filter(Boolean).join(' — ');
      await run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', b.title, text]);
      return;
    }
    const [image, icon] = await Promise.all([this.framed(b.image), this.png(b.icon)]);
    const args = ['-title', b.title, '-subtitle', b.subtitle, '-message', b.message || ' ', '-group', b.group, '-open', b.url];
    if (image) args.push('-contentImage', image);
    if (icon) args.push('-appIcon', icon);
    await run(tool, args);
  }

  async remove(group: string) {
    if (process.platform !== 'darwin') return;
    const tool = await this.notifier();
    if (tool) await run(tool, ['-remove', group]);
  }
}

/** JXA: draws argv[0] rounded, inset 18px in a transparent 128px PNG at argv[1]. */
const FRAME_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const img = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  if (!img || img.isNil()) return;
  const S = 128, inset = 18, r = 22;
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, S, S, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  const box = $.NSMakeRect(inset, inset, S - 2 * inset, S - 2 * inset);
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(box, r, r).addClip;
  img.drawInRectFromRectOperationFraction(box, $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(argv[1], true);
}`;

const RULE = /^\s*[─━═]{8,}\s*$/;

/**
 * What the agent last said, from its screen: the start of its last message, a line or two.
 * Knows Claude Code's `⏺` and Explyt's `✦ hh:mm:ss` message marks; otherwise the last paragraph.
 */
export function lastMessage(screen: string, blocked: boolean): string {
  let lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''));
  // Drop the input box and status lines at the bottom: everything from the first rule of the last group.
  let cut = lines.length;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) if (RULE.test(lines[i])) cut = i;
  lines = lines.slice(0, cut);
  // Explyt's one-space notices just above the input box (`  Explyt … is installed`).
  while (lines.length && (/^ \S/.test(lines[lines.length - 1]) || !lines[lines.length - 1].trim())) lines.pop();
  // Hints aligned far right (`new task? /clear …`) and tool output aren't the message.
  const prose = (l: string) => Boolean(l.trim()) && !/^\s{10,}/.test(l) && !/^\s*(▎|⎿|│|├|└|⏵)/.test(l);

  let start = -1;
  for (let i = lines.length - 1; i >= 0 && start < 0; i--) {
    const l = lines[i];
    if (/^✦\s+\d{1,2}:\d{2}/.test(l)) start = i + 1;
    // A Claude text block, not a tool call (`⏺ Bash(…)`, followed by `⎿`).
    else if (/^⏺\s/.test(l) && !/^⏺\s+[\w.-]+\(/.test(l) && !/^\s*⎿/.test(lines[i + 1] ?? '')) start = i;
  }
  if (start < 0) {
    let end = lines.length;
    while (end > 0 && !prose(lines[end - 1])) end--;
    start = end;
    while (start > 0 && prose(lines[start - 1])) start--;
  }
  // The message: its lines down to the bottom, past blank lines, stopping at tool output.
  const message: string[] = [];
  for (const l of lines.slice(start)) {
    if (!l.trim()) continue;
    if (!prose(l)) { if (message.length) break; continue; }
    message.push(l);
  }
  // A closing question is what the agent wants from you: show that.
  const last = message[message.length - 1] ?? '';
  if (/\?\s*$/.test(last) && (blocked || message.length > 1)) return clean([last]);
  const head: string[] = [];
  for (const l of message) {
    head.push(l);
    if (head.join(' ').length > 200) break;
  }
  return clean(head);
}

function clean(lines: string[]): string {
  const s = lines
    .map((l) => l.replace(/^\s*(⏺|✦|❯|>|[-*•]|\d+\.)\s+/, '').trim())
    .filter((l) => !/^```/.test(l))
    .join(' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 220 ? `${s.slice(0, 217).replace(/\s+\S*$/, '')}…` : s;
}
