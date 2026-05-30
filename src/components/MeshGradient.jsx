import { useEffect, useRef } from 'react'

const VERT = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const FRAG = `
precision highp float;

uniform vec2  u_resolution;
uniform float u_time;
uniform vec2  u_mouse;
uniform vec2  u_mouseVel;
uniform float u_grain;
uniform float u_undulate;

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)),
           dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = vec3(
    dot(hash22(i + vec2(0.0)), vec2(1.0)),
    dot(hash22(i + i1),        vec2(1.0)),
    dot(hash22(i + vec2(1.0)), vec2(1.0))
  );
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * snoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

float gold(vec2 xy, float seed) {
  return fract(tan(distance(xy * 1.61803398875, xy) * seed) * xy.x);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv   = frag / u_resolution.xy;
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = uv;
  p.x *= aspect;

  float t = u_time * 0.05;

  vec2 m = u_mouse;
  m.x *= aspect;

  vec2 axisDir = normalize(vec2(1.0, -1.0));
  float axisMin = dot(vec2(0.0, 1.0),      axisDir);
  float axisMax = dot(vec2(aspect, 0.0),   axisDir);

  vec2 bandDir = normalize(vec2(1.0, 1.0));
  float along  = dot(p, bandDir);
  float across = dot(p, axisDir);

  float wave =
        0.55 * snoise(vec2(along * 0.55, across * 1.8 + t * 0.9))
      + 0.35 * snoise(vec2(along * 1.30 - t * 0.6, across * 2.6))
      + 0.18 * snoise(vec2(along * 2.40 + t * 0.4, across * 4.1 - t * 0.3));

  float mouseSwell = exp(-distance(p, m) * 2.0) * (u_mouseVel.x - u_mouseVel.y) * 6.0;
  wave += mouseSwell;

  float undulation = 0.18 * u_undulate;
  float axisRaw = across + undulation * wave;
  float axis = (axisRaw - axisMin) / (axisMax - axisMin);
  axis = clamp(axis, 0.0, 1.0);

  vec3 navy   = vec3(0.043, 0.078, 0.243);
  vec3 indigo = vec3(0.105, 0.150, 0.360);
  vec3 dust   = vec3(0.640, 0.575, 0.530);
  vec3 amber  = vec3(0.660, 0.300, 0.130);
  vec3 rust   = vec3(0.460, 0.155, 0.075);
  vec3 ember  = vec3(0.095, 0.042, 0.038);
  vec3 glow   = vec3(0.800, 0.620, 0.500);

  #define BAND(c, w) exp(-pow((axis - (c)) / (w), 2.0))
  float bN = BAND(0.00, 0.32);
  float bI = BAND(0.28, 0.22);
  float bD = BAND(0.50, 0.16);
  float bA = BAND(0.72, 0.22);
  float bR = BAND(0.92, 0.22);
  float bE = BAND(1.05, 0.18);

  float bSum = bN + bI + bD + bA + bR + bE + 1e-4;
  vec3 col = (navy*bN + indigo*bI + dust*bD + amber*bA + rust*bR + ember*bE) / bSum;

  float tintN = fbm(p * 0.7 + vec2(0.0, t * 0.5)) * 0.5 + 0.5;
  col = mix(col, col * vec3(0.92, 0.94, 1.05), (tintN - 0.5) * 0.35);

  float md = distance(p, m);
  float glowW = exp(-md * 3.2) * 0.22;
  col = mix(col, glow, glowW);

  float cornerD = 1.0 - smoothstep(0.2, 1.2, distance(p, vec2(aspect * 1.0, 0.0)));
  col = mix(col, ember, cornerD * 0.45);

  float vig = smoothstep(1.40, 0.45, length(uv - 0.5));
  col *= mix(0.88, 1.0, vig);

  float g1 = gold(frag, 0.07 + mod(u_time, 60.0) * 0.0001) - 0.5;
  float g2 = gold(frag.yx + 17.3, 0.13) - 0.5;
  float grain = (g1 * 0.7 + g2 * 0.3);
  col += grain * u_grain;

  col = pow(max(col, 0.0), vec3(0.95));
  col += (gold(frag, 1.7) - 0.5) * (1.0 / 255.0);

  gl_FragColor = vec4(col, 1.0);
}
`

export default function MeshGradient() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false })
    if (!gl) return

    function compile(type, src) {
      const s = gl.createShader(type)
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s))
      }
      return s
    }

    const vs = compile(gl.VERTEX_SHADER, VERT)
    const fs = compile(gl.FRAGMENT_SHADER, FRAG)
    const prog = gl.createProgram()
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1,  1,
      -1,  1,  1, -1,  1,  1,
    ]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'a_position')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const uRes      = gl.getUniformLocation(prog, 'u_resolution')
    const uTime     = gl.getUniformLocation(prog, 'u_time')
    const uMouse    = gl.getUniformLocation(prog, 'u_mouse')
    const uMouseVel = gl.getUniformLocation(prog, 'u_mouseVel')
    const uGrain    = gl.getUniformLocation(prog, 'u_grain')
    const uUnd      = gl.getUniformLocation(prog, 'u_undulate')

    const state = {
      mx: 0.5, my: 0.5,
      tmx: 0.5, tmy: 0.5,
      vx: 0, vy: 0,
      lastTmx: 0.5, lastTmy: 0.5,
      start: performance.now(),
      dpr: Math.min(window.devicePixelRatio || 1, 2),
    }

    function resize() {
      state.dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.floor(canvas.clientWidth  * state.dpr)
      const h = Math.floor(canvas.clientHeight * state.dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width  = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
    }
    window.addEventListener('resize', resize)
    resize()

    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect()
      state.tmx = (e.clientX - rect.left) / rect.width
      state.tmy = 1.0 - (e.clientY - rect.top) / rect.height
      lastMove = performance.now()
    }
    window.addEventListener('pointermove', onMove, { passive: true })

    let lastMove = performance.now()
    let raf

    function frame() {
      const now = performance.now()
      const t = (now - state.start) / 1000

      if (now - lastMove > 1800) {
        const k = Math.min(1, (now - lastMove - 1800) / 2000)
        const dx = 0.5 + 0.32 * Math.sin(t * 0.18)
        const dy = 0.5 + 0.24 * Math.cos(t * 0.22 + 1.3)
        state.tmx += (dx - state.tmx) * 0.012 * k
        state.tmy += (dy - state.tmy) * 0.012 * k
      }

      const lerp = 0.06
      state.mx += (state.tmx - state.mx) * lerp
      state.my += (state.tmy - state.my) * lerp

      const ivx = state.tmx - state.lastTmx
      const ivy = state.tmy - state.lastTmy
      state.lastTmx = state.tmx
      state.lastTmy = state.tmy
      state.vx = state.vx * 0.88 + ivx * 0.12
      state.vy = state.vy * 0.88 + ivy * 0.12

      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, t)
      gl.uniform2f(uMouse, state.mx, state.my)
      gl.uniform2f(uMouseVel, state.vx, state.vy)
      gl.uniform1f(uGrain, 0.085)
      gl.uniform1f(uUnd, 1.0)

      gl.drawArrays(gl.TRIANGLES, 0, 6)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        display: 'block',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  )
}
