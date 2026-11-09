// Anime mascots for the agent harnesses, as small data URIs (media/mascots/<program>.png).
import * as fs from 'fs';
import * as path from 'path';

export class Mascots {
  private cache = new Map<string, string | undefined>();

  constructor(private dir: string) {}

  /** The mascot of a program key (`claude`, `explyt`…), if there is one. */
  uri(program: string): string | undefined {
    if (this.cache.has(program)) return this.cache.get(program);
    const file = this.file(program);
    const uri = file ? `data:image/webp;base64,${fs.readFileSync(file).toString('base64')}` : undefined;
    this.cache.set(program, uri);
    return uri;
  }

  file(program: string): string | undefined {
    const file = path.join(this.dir, `${program}.webp`);
    return fs.existsSync(file) ? file : undefined;
  }

  /** A PNG for macOS banners, which can't show webp. */
  png(program: string): string | undefined {
    const file = path.join(this.dir, 'png', `${program}.png`);
    return fs.existsSync(file) ? file : undefined;
  }
}
