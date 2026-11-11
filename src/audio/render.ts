/**
 * Buffer rendering service.
 *
 * Every procedural buffer (one-shot variants, loop beds) is rendered in a Web Worker so the main
 * thread never stalls (measured on the main thread: 4.8 s of CPU at 48 kHz, 9.8 s at 96 kHz, single
 * sounds up to 1.5 s — that froze the game's frames for seconds after unlock). Buffers are rendered
 * at min(context rate, 48 kHz) (the source nodes resample; nothing audible is lost) and kept as
 * context-free AudioBuffers, so an AudioContext rebuild after a device failure costs nothing.
 * If the worker cannot start, jobs run on the main thread one per macrotask (the old behaviour).
 */
import type { Stereo } from './dsp';
import type { RenderJob } from './jobs';
import RenderWorker from './render.worker?worker&inline';

interface Pending {
  res: (v: Stereo[]) => void;
  rej: (e: unknown) => void;
  job: RenderJob;
}

export class Renderer {
  private worker: Worker | null = null;
  private broken = false;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  /** Diagnostics. */
  readonly stats = { jobs: 0, workerJobs: 0, mainThreadJobs: 0, mainThreadMs: 0 };

  constructor(private readonly fallback: (job: RenderJob) => Stereo[]) {}

  request(job: RenderJob): Promise<Stereo[]> {
    this.stats.jobs++;
    const w = this.getWorker();
    if (!w) return this.runHere(job);
    const id = ++this.seq;
    return new Promise<Stereo[]>((res, rej) => {
      this.pending.set(id, { res, rej, job });
      try {
        w.postMessage({ id, job });
      } catch (e) {
        this.pending.delete(id);
        this.fail(e);
        this.runHere(job).then(res, rej);
      }
    });
  }

  get pendingJobs(): number {
    return this.pending.size;
  }

  private getWorker(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    if (typeof Worker === 'undefined') {
      this.broken = true;
      return null;
    }
    try {
      const w = new RenderWorker();
      w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; out?: Stereo[]; error?: string }>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.ok && e.data.out) {
          this.stats.workerJobs++;
          p.res(e.data.out);
        } else this.runHere(p.job).then(p.res, p.rej);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        this.fail(e.message);
      };
      this.worker = w;
    } catch (e) {
      this.fail(e);
    }
    return this.worker;
  }

  /** Worker died: finish everything it still owed on the main thread and never use it again. */
  private fail(e: unknown): void {
    if (this.broken) return;
    console.warn('[audio] render worker unavailable, rendering on the main thread', e);
    this.broken = true;
    try {
      this.worker?.terminate();
    } catch {
      /* ignore */
    }
    this.worker = null;
    const owed = [...this.pending.values()];
    this.pending.clear();
    for (const p of owed) this.runHere(p.job).then(p.res, p.rej);
  }

  private runHere(job: RenderJob): Promise<Stereo[]> {
    return new Promise((res, rej) =>
      setTimeout(() => {
        const t = performance.now();
        try {
          res(this.fallback(job));
        } catch (e) {
          rej(e);
        }
        this.stats.mainThreadJobs++;
        this.stats.mainThreadMs += performance.now() - t;
      }, 0),
    );
  }
}
