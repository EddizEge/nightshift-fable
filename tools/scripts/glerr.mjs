// Debug helper: which draw raises a GL error?
export default async ({ page, log }) => {
  const res = await page.evaluate(async () => {
    const k = window.__kit;
    const r = k.engine.renderer;
    const gl = r.getContext();
    const hits = new Map();
    const orig = r.renderBufferDirect.bind(r);
    r.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      gl.getError();
      orig(camera, scene, geometry, material, object, group);
      const e = gl.getError();
      if (e) {
        const rt = r.getRenderTarget();
        const key = `${e} ${material.name || material.type} on ${object.name || object.type} rt=${rt ? rt.texture.name || rt.width + 'x' + rt.height : 'screen'} recvShadow=${object.receiveShadow}`;
        hits.set(key, (hits.get(key) || 0) + 1);
      }
    };
    await new Promise((res) => setTimeout(res, 1200));
    r.renderBufferDirect = orig;
    return [...hits.entries()];
  });
  log(JSON.stringify(res, null, 1));
};
