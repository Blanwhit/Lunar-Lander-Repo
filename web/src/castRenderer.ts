import { SRGBColorSpace, WebGLRenderer, WebGLRenderTarget } from 'three';

// The globe already has a WebGL context. Use a small offscreen target there if
// the browser cannot allocate another context for the desktop spectator.
export function castRenderer(canvas: HTMLCanvasElement, globe: WebGLRenderer) {
  let dedicated: WebGLRenderer;
  try {
    dedicated = new WebGLRenderer({canvas, antialias: false, powerPreference: 'high-performance'});
  } catch (error) {
    const ctx = canvas.getContext('2d', {alpha: false});
    if (!ctx) throw error;
    const target = new WebGLRenderTarget(1, 1);
    target.texture.colorSpace = SRGBColorSpace;
    let pixels = ctx.createImageData(1, 1);
    let bytes = new Uint8Array(pixels.data.buffer);
    // Framebuffer rows arrive bottom first.
    canvas.width = canvas.height = 1;
    canvas.style.transform = 'scaleY(-1)';
    return {
      renderer: globe, shared: true,
      resize(width: number, height: number) {
        canvas.width = width; canvas.height = height;
        target.setSize(width, height);
        pixels = ctx.createImageData(width, height);
        bytes = new Uint8Array(pixels.data.buffer);
      },
      draw(render: () => void) {
        const previous = globe.getRenderTarget(), shadows = globe.shadowMap.enabled, clear = globe.autoClear;
        try {
          globe.setRenderTarget(target);
          globe.shadowMap.enabled = true;
          globe.autoClear = true;
          render();
          globe.readRenderTargetPixels(target, 0, 0, target.width, target.height, bytes);
          ctx.putImageData(pixels, 0, 0);
        } finally {
          globe.setRenderTarget(previous);
          globe.shadowMap.enabled = shadows;
          globe.autoClear = clear;
        }
      },
      close() { target.dispose(); canvas.style.transform = ''; },
    };
  }
  dedicated.shadowMap.enabled = true;
  return {
    renderer: dedicated, shared: false,
    resize(width: number, height: number) { dedicated.setSize(width, height, false); },
    draw(render: () => void) { render(); },
    close() { dedicated.dispose(); dedicated.forceContextLoss(); },
  };
}
