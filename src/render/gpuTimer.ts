interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/**
 * Whole-frame GPU time through EXT_disjoint_timer_query_webgl2 (Chrome / Edge on desktop).
 * Results arrive a few frames late; `ms` is a smoothed value. When the extension is missing
 * (Firefox, Safari) `available` stays false and callers fall back to frame intervals.
 */
export class GpuTimer {
  readonly available: boolean;
  /** Smoothed GPU milliseconds per frame. */
  ms = 0;
  /** Number of results received so far. */
  samples = 0;
  private ext: TimerExt | null;
  private active: WebGLQuery | null = null;
  private pending: WebGLQuery[] = [];

  constructor(private gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    this.available = !!this.ext;
  }

  begin(): void {
    const { gl, ext } = this;
    if (!ext || this.active || this.pending.length > 4) return;
    // Only one elapsed-time query may be active per context: stand back if a test harness has one.
    if (gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return;
    const q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    const { gl, ext } = this;
    if (!ext) return;
    if (this.active) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) {
        const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        this.ms = this.samples === 0 ? ms : this.ms + (ms - this.ms) * 0.12;
        this.samples++;
      }
      gl.deleteQuery(q);
      this.pending.shift();
    }
  }
}
