// Quick probe: does headless Chromium get hardware WebGL2 on this machine?
import { chromium } from 'playwright';
const variants = [
  { name: 'headless+angle-d3d11', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] },
  { name: 'headless-default', headless: true, args: [] },
];
for (const v of variants) {
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: v.headless, args: v.args });
    const page = await browser.newPage();
    await page.goto('about:blank');
    const info = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return { webgl2: false };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        webgl2: true,
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        floatBuf: !!gl.getExtension('EXT_color_buffer_float'),
        halfFloatBuf: !!gl.getExtension('EXT_color_buffer_half_float'),
        webgpu: 'gpu' in navigator,
      };
    });
    console.log(v.name, JSON.stringify(info));
  } catch (e) {
    console.log(v.name, 'ERROR', String(e).slice(0, 300));
  } finally {
    await browser?.close();
  }
}
