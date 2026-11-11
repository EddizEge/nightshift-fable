export default async ({ page, log }) => {
  const res = await page.evaluate(async () => {
    const NS = window.__NS;
    const r = NS.engine.renderer;
    await new Promise((res) => setTimeout(res, 1500));
    const c = NS.engine.composer;
    const d = c.depthRenderTarget;
    const info = (rt) => rt && ({
      size: `${rt.width}x${rt.height}`, tex: `${rt.texture.image.width}x${rt.texture.image.height}`, samples: rt.samples,
      depthTex: rt.depthTexture ? `${rt.depthTexture.image.width}x${rt.depthTexture.image.height} v${rt.depthTexture.version} name=${rt.depthTexture.name} owner=${rt.depthTexture.renderTarget === rt}` : null,
      props: Object.keys(r.properties.get(rt)).join(','),
      dprops: rt.depthTexture ? JSON.stringify(Object.fromEntries(Object.entries(r.properties.get(rt.depthTexture)).map(([k, v]) => [k, typeof v === 'object' ? (v && v.constructor.name) : v]))) : null,
    });
    return { pr: r.getPixelRatio(), input: info(c.inputBuffer), output: info(c.outputBuffer), depth: info(d) };
  });
  log(JSON.stringify(res, null, 1));
};
