// Debug helper: which material triggers "Trying to use N texture units"?
export default async ({ page, log, sleep }) => {
  const res = await page.evaluate(async () => {
    const k = window.__kit;
    const r = k.engine.renderer;
    let current = '';
    const orig = r.renderBufferDirect.bind(r);
    r.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      current = `${material.name || material.type} on ${object.name || object.type} tex=${Object.keys(material).filter((key) => material[key] && material[key].isTexture).join(',')}`;
      return orig(camera, scene, geometry, material, object, group);
    };
    const hits = new Map();
    const w = console.warn;
    console.warn = (...a) => {
      if (String(a[0]).includes('texture units')) hits.set(current, (hits.get(current) || 0) + 1);
      else w(...a);
    };
    await new Promise((res) => setTimeout(res, 1500));
    return [...hits.entries()];
  });
  log(JSON.stringify(res, null, 1));
};
