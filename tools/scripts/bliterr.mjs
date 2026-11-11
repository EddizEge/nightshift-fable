// Debug helper: which blitFramebuffer call raises a GL error, and what do the framebuffers look like?
export default async ({ page, log }) => {
  const res = await page.evaluate(async () => {
    const NS = window.__NS;
    const r = NS.engine.renderer;
    const gl = r.getContext();
    const hits = new Map();
    const orig = gl.blitFramebuffer.bind(gl);
    const describe = (target) => {
      const out = [];
      for (const [name, att] of [['color', gl.COLOR_ATTACHMENT0], ['depth', gl.DEPTH_ATTACHMENT]]) {
        const type = gl.getFramebufferAttachmentParameter(target, att, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
        if (type === gl.NONE) { out.push(`${name}:none`); continue; }
        const obj = gl.getFramebufferAttachmentParameter(target, att, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
        if (type === gl.RENDERBUFFER) {
          const prev = gl.getParameter(gl.RENDERBUFFER_BINDING);
          gl.bindRenderbuffer(gl.RENDERBUFFER, obj);
          out.push(`${name}:rb ${gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_WIDTH)}x${gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_HEIGHT)} s${gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_SAMPLES)}`);
          gl.bindRenderbuffer(gl.RENDERBUFFER, prev);
        } else out.push(`${name}:tex`);
      }
      return out.join(' ') + ' status=' + gl.checkFramebufferStatus(target).toString(16);
    };
    gl.blitFramebuffer = (...a) => {
      gl.getError();
      const pre = `read[${describe(gl.READ_FRAMEBUFFER)}] draw[${describe(gl.DRAW_FRAMEBUFFER)}] args=${a.slice(0, 8).join(',')} mask=${a[8]}`;
      orig(...a);
      const e = gl.getError();
      const key = `${e ? 'ERR ' + e.toString(16) : 'ok'} ${pre} @ ${new Error().stack.split('\n').slice(2, 6).map((s) => s.trim().replace(/\(?https?:\/\/[^/]+\//, '').slice(0, 90)).join(' < ')}`;
      hits.set(key, (hits.get(key) || 0) + 1);
    };
    await new Promise((res) => setTimeout(res, 1500));
    gl.blitFramebuffer = orig;
    return [...hits.entries()].map(([k, n]) => `${n}× ${k}`);
  });
  for (const l of res) log(l);
};
