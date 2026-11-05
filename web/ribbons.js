/* Draw route ribbons as one world-space mesh. Unlike tiled, zoom-dependent line widths,
 * both sides of every ribbon use the same camera transform as its centerline. A fast
 * pinch can never separate a bundle while the map is still loading its child tiles.
 * compile() is also used in the geometry worker; it has no DOM or WebGL dependency. */
const KCTMRibbons = (() => {
  "use strict";
  const X0 = (-122.33 + 180) / 360;
  const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
  const Y0 = mercY(47.61), STRIDE = 10;
  const project = ([lon, lat]) => [(lon + 180) / 360 - X0, mercY(lat) - Y0];
  const rgb = (c) => {
    if (/^#[0-9a-f]{6}$/i.test(c || "")) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
    const values = /^rgba?\(([^)]+)\)/.exec(c || "");
    return values ? values[1].split(",").slice(0, 3).map((v) => Number(v.trim()) / 255) : [0.3, 0.3, 0.3];
  };

  function compile(features, { widthScale = 1, selected = false, hover = false } = {}) {
    const buckets = new Map();
    const bucket = (stack, role) => {
      const key = stack + ":" + role;
      if (!buckets.has(key)) buckets.set(key, { stack, role, data: [] });
      return buckets.get(key).data;
    };
    for (const f of features.slice().sort((a, b) => (a.properties.s || 0) - (b.properties.s || 0))) {
      const p = f.properties, pts = f.geometry.coordinates.map(project).filter((q, i, a) => !i || Math.hypot(q[0] - a[i - 1][0], q[1] - a[i - 1][1]) > 1e-13);
      if (pts.length < 2 || !(p.zu > 0)) continue;
      const stack = p.g === "rail" || /^link|sounder/.test(p.cat) ? 1 : 0;
      const c = rgb(p.c), ns = [], miters = [], ds = [0];
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], len = Math.hypot(dx, dy);
        ns.push([-dy / len, dx / len]); ds.push(ds[i - 1] + len);
      }
      for (let i = 0; i < pts.length; i++) {
        const a = ns[Math.max(0, i - 1)], b = ns[Math.min(i, ns.length - 1)];
        let x = a[0] + b[0], y = a[1] + b[1], len = Math.hypot(x, y);
        if (len < 1e-8) { miters.push(b); continue; }
        x /= len; y /= len;
        const scale = 1 / Math.max(0.5, x * b[0] + y * b[1]);
        miters.push([x * scale, y * scale]);
      }
      const stroke = (role, width, pattern = 0, round = true) => {
        if (!(width > 0)) return;
        const out = bucket(stack, role), hw = width * p.zu / 1024;
        const vertex = (i, nx, ny, side) => out.push(pts[i][0], pts[i][1], nx * hw, ny * hw, side, hw, ds[i] / (2 * hw), ...c);
        for (let i = 1; i < pts.length; i++) {
          const a = miters[i - 1], b = miters[i];
          vertex(i - 1, a[0], a[1], 1); vertex(i - 1, -a[0], -a[1], -1); vertex(i, b[0], b[1], 1);
          vertex(i, b[0], b[1], 1); vertex(i - 1, -a[0], -a[1], -1); vertex(i, -b[0], -b[1], -1);
        }
        // Semicircular ends, including an antialiased outer edge.
        if (round) for (const i of [0, pts.length - 1]) {
          const n = ns[i ? ns.length - 1 : 0], angle = Math.atan2(n[1], n[0]);
          const sign = i ? -1 : 1;
          for (let k = 0; k < 8; k++) {
            const a = angle + sign * Math.PI * k / 8, b = angle + sign * Math.PI * (k + 1) / 8;
            vertex(i, 0, 0, 0); vertex(i, Math.cos(a), Math.sin(a), 1); vertex(i, Math.cos(b), Math.sin(b), 1);
          }
        }
        // A batch has one pattern; dashed bodies and dotted/tied centers are separate roles.
        if (pattern) buckets.get(stack + ":" + role).pattern = pattern;
      };
      if (selected) stroke("glow", p.gm, 0);
      if (!hover && !selected && p.sh > 0) stroke("shadow", p.sh + 0.8);
      if (!p.d) stroke("case", p.cm * widthScale * (hover ? 0.97 : 1));
      const w = p.wm * widthScale;
      stroke(p.d ? "dash" : "body", w, p.d ? 1 : 0, !p.d);
      if (!hover && p.hm > 0) stroke(p.h === 3 ? "dots" : p.h === 4 ? "ties" : "shine", p.hm, p.h === 3 ? 2 : p.h === 4 ? 3 : 0, p.h !== 4);
    }
    const order = ["shadow", "glow", "case", "body", "dash", "shine", "dots", "ties"];
    return [...buckets.values()].sort((a, b) => a.stack - b.stack || order.indexOf(a.role) - order.indexOf(b.role))
      .map((b) => ({ ...b, data: new Float32Array(b.data) }));
  }

  function createLayer(getStyle) {
    let map, gl, program, attribs, uniforms, vao, vaoExt;
    const slots = new Map(), matrix = new Float32Array(16);
    const shader = (type, source) => {
      const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const error = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(error); }
      return s;
    };
    const release = (slot) => { for (const b of slot?.batches || []) if (b.buffer) gl.deleteBuffer(b.buffer); };
    const layer = {
      id: "route-ribbons", type: "custom", renderingMode: "2d",
      onAdd(m, context) {
        map = m; gl = context;
        const v2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
        vaoExt = v2 ? null : gl.getExtension("OES_vertex_array_object");
        vao = v2 ? gl.createVertexArray() : vaoExt?.createVertexArrayOES();
        const head = v2 ? "#version 300 es\n" : "";
        const attr = v2 ? "in" : "attribute", vo = v2 ? "out" : "varying", vi = v2 ? "in" : "varying";
        const vs = shader(gl.VERTEX_SHADER, `${head}precision highp float;
          uniform mat4 u_matrix; uniform float u_pixels;
          ${attr} vec2 a_pos; ${attr} vec2 a_extrude; ${attr} float a_side;
          ${attr} float a_half; ${attr} float a_distance; ${attr} vec3 a_color;
          ${vo} float v_side; ${vo} float v_half; ${vo} float v_distance; ${vo} vec3 v_color;
          void main() { gl_Position = u_matrix * vec4(a_pos + a_extrude, 0.0, 1.0);
            v_side = a_side; v_half = a_half * u_pixels; v_distance = a_distance; v_color = a_color; }`);
        const fs = shader(gl.FRAGMENT_SHADER, `${head}precision highp float;
          uniform vec4 u_color; uniform float u_own; uniform float u_opacity; uniform float u_pattern; uniform float u_soft;
          ${vi} float v_side; ${vi} float v_half; ${vi} float v_distance; ${vi} vec3 v_color;
          ${v2 ? "out vec4 fragColor;" : ""}
          void main() {
            float aa = min(1.0, 0.85 / max(0.1, v_half));
            float alpha = 1.0 - smoothstep(1.0 - max(aa, u_soft), 1.0, abs(v_side));
            if (u_pattern > 0.5) {
              float period = u_pattern < 1.5 ? 3.5 : u_pattern < 2.5 ? 2.6 : 2.8;
              float dash = u_pattern < 1.5 ? 2.2 : u_pattern < 2.5 ? 0.2 : 1.2;
              float along = mod(v_distance, period);
              if (u_pattern > 1.5 && u_pattern < 2.5) {
                float dx = min(along, period - along) * 2.0;
                alpha *= 1.0 - smoothstep(1.0 - aa, 1.0, length(vec2(dx, v_side)));
              } else if (along > dash) discard;
            }
            vec3 color = mix(u_color.rgb, v_color, u_own);
            alpha *= u_opacity * u_color.a;
            ${v2 ? "fragColor" : "gl_FragColor"} = vec4(color * alpha, alpha);
          }`);
        program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
        gl.deleteShader(vs); gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        attribs = ["pos", "extrude", "side", "half", "distance", "color"].map((n) => gl.getAttribLocation(program, "a_" + n));
        uniforms = Object.fromEntries(["matrix", "pixels", "color", "own", "opacity", "pattern", "soft"].map((n) => [n, gl.getUniformLocation(program, "u_" + n)]));
      },
      update(name, mesh) {
        const old = slots.get(name); if (gl) release(old);
        slots.set(name, { batches: mesh }); map?.triggerRepaint();
      },
      restore() {
        for (const slot of slots.values()) for (const b of slot.batches) b.buffer = null;
        layer.onAdd(map, gl); map.triggerRepaint();
      },
      render(context, transform) {
        if (!program) return;
        const style = getStyle(), pixels = 512 * 2 ** map.getZoom();
        matrix.set(transform);
        // Translate in double precision before uploading, preserving sub-meter detail.
        for (let i = 0; i < 4; i++) matrix[12 + i] = transform[12 + i] + transform[i] * X0 + transform[4 + i] * Y0;
        gl.useProgram(program); gl.uniformMatrix4fv(uniforms.matrix, false, matrix); gl.uniform1f(uniforms.pixels, pixels);
        if (gl.bindVertexArray) gl.bindVertexArray(vao); else vaoExt?.bindVertexArrayOES(vao);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST);
        for (const name of ["net", "hover", "hover2", "sel"]) {
          const slot = slots.get(name); if (!slot) continue;
          const opacity = name === "net" ? style.dim : name === "sel" ? 1 : style.hover[name === "hover" ? 0 : 1];
          if (opacity < 0.001) continue;
          for (const b of slot.batches) {
            if (name === "net" && style.selected && !["body", "dash"].includes(b.role)) continue;
            if (b.role === "shadow" && map.getZoom() < 11) continue;
            if (!b.buffer) { b.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b.buffer); gl.bufferData(gl.ARRAY_BUFFER, b.data, gl.STATIC_DRAW); }
            else gl.bindBuffer(gl.ARRAY_BUFFER, b.buffer);
            const sizes = [2, 2, 1, 1, 1, 3], offsets = [0, 2, 4, 5, 6, 7];
            for (let i = 0; i < attribs.length; i++) { gl.enableVertexAttribArray(attribs[i]); gl.vertexAttribPointer(attribs[i], sizes[i], gl.FLOAT, false, STRIDE * 4, offsets[i] * 4); }
            const own = ["body", "dash", "glow"].includes(b.role), color = rgb(b.role === "case" || b.role === "ties" ? style.casing : b.role === "shadow" ? style.shadow : style.shine);
            gl.uniform4f(uniforms.color, ...color, 1); gl.uniform1f(uniforms.own, own ? 1 : 0);
            const alpha = b.role === "shadow" ? 0.12 : b.role === "glow" ? 0.28 : b.role === "shine" ? 0.4 : 1;
            gl.uniform1f(uniforms.opacity, opacity * alpha); gl.uniform1f(uniforms.pattern, b.pattern || 0);
            gl.uniform1f(uniforms.soft, b.role === "shadow" || b.role === "glow" ? 0.9 : 0);
            gl.drawArrays(gl.TRIANGLES, 0, b.data.length / STRIDE);
          }
        }
        if (gl.bindVertexArray) gl.bindVertexArray(null); else if (vaoExt) vaoExt.bindVertexArrayOES(null);
        else for (const a of attribs) gl.disableVertexAttribArray(a);
      },
      onRemove() {
        for (const slot of slots.values()) release(slot); slots.clear();
        if (program) gl.deleteProgram(program); program = null;
        if (gl.deleteVertexArray) gl.deleteVertexArray(vao); else vaoExt?.deleteVertexArrayOES(vao);
      },
      stats: () => ({ batches: [...slots.values()].reduce((n, s) => n + s.batches.length, 0), vertices: [...slots.values()].reduce((n, s) => n + s.batches.reduce((a, b) => a + b.data.length / STRIDE, 0), 0) }),
    };
    return layer;
  }
  return { compile, createLayer, project, STRIDE };
})();
