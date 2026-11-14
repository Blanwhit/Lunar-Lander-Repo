// Benchmark harness (dev tool, not part of the app). Paste into the console of a running
// viewer (window.__moon must exist) or inject via devtools automation.
//
//   await moonBench()   -> per-view stats: tiles, triangles, GPU MB, CPU+GPU frame ms
//
// Each frame is forced with step() + gl.finish(), so the time is the full CPU (LOD
// selection, uniforms) + GPU cost, independent of vsync / rAF throttling. GPU-only time
// comes from EXT_disjoint_timer_query_webgl2 when available.
window.moonBench = async function moonBench(views, frames = 120) {
  const m = window.__moon;
  const gl = m.renderer.getContext();
  const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  views = views || [
    { name: 'whole Moon', hash: '#0,0,5200000,0,0' },
    { name: 'orbit 200 km', hash: '#-30,-15,200000,0,0' },
    { name: 'Shackleton 25 km', hash: '#-89.67,129.8,25000,0,55' },
    { name: 'Shackleton rim 3 km', hash: '#-89.33,129.8,3000,180,65' },
  ];
  const settle = async () => {
    for (let i = 0; i < 400; i++) {
      m.step(1 / 60);
      await new Promise((r) => setTimeout(r, 30));
      if (!m.tree.isBusy() && i > 20) break;
    }
  };
  const out = [];
  for (const v of views) {
    location.hash = v.hash;
    await new Promise((r) => setTimeout(r, 50));
    await settle();
    const ms = [];
    const gpu = [];
    for (let i = 0; i < frames; i++) {
      m.controls.rotateHeading(0.004); // keep the camera moving: every frame re-selects + redraws
      let q = null;
      if (tq) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
      const t0 = performance.now();
      m.step(1 / 60);
      if (q) gl.endQuery(tq.TIME_ELAPSED_EXT);
      gl.finish();
      ms.push(performance.now() - t0);
      if (q) {
        await new Promise((r) => setTimeout(r, 0));
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(tq.GPU_DISJOINT_EXT))
          gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
    }
    ms.sort((a, b) => a - b);
    gpu.sort((a, b) => a - b);
    const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
    out.push({
      view: v.name,
      tiles: m.tree.stats.drawn,
      maxLevel: m.tree.stats.maxLevelDrawn,
      Mtris: +(m.tree.stats.triangles / 1e6).toFixed(2),
      gpuTexMB: +(m.tree.gpuBytes / 1048576).toFixed(0),
      frameMsAvg: +avg.toFixed(2),
      frameMsP95: +ms[Math.floor(ms.length * 0.95)].toFixed(2),
      fpsEquiv: +(1000 / avg).toFixed(0),
      gpuMsMedian: gpu.length ? +gpu[gpu.length >> 1].toFixed(2) : null,
    });
  }
  const c = m.renderer.domElement;
  return { canvas: `${c.width}x${c.height} (dpr ${m.renderer.getPixelRatio()})`, gpu: gl.getParameter(gl.RENDERER), results: out };
};
