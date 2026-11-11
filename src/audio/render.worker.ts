/**
 * Render worker: runs the procedural one-shot / loop recipes off the main thread (≈ 5 s of CPU at
 * 48 kHz in total, 10 s at 96 kHz — far too much to do between frames) and transfers the samples back.
 * Bundled inline (Blob URL) by Vite, so no extra file has to be served.
 */
import { runJob, type RenderJob } from './jobs';

interface Req {
  id: number;
  job: RenderJob;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, job } = e.data;
  try {
    const out = runJob(job);
    const transfer = new Set<ArrayBuffer>();
    for (const st of out) transfer.add(st.L.buffer as ArrayBuffer).add(st.R.buffer as ArrayBuffer);
    self.postMessage({ id, ok: true, out }, { transfer: [...transfer] });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
