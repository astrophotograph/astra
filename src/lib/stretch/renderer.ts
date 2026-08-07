/**
 * WebGL2 renderer for the live-stretch preview.
 *
 * Uploads the pre-stretch float data as a texture once; every parameter
 * change is a handful of uniform updates and one fullscreen-triangle draw.
 * The fragment shader mirrors the tail of the processinator pipeline —
 * shadow/scale clamp → MTF → green removal → saturation — so the preview
 * matches what Apply (the Rust pipeline) will produce. The GLSL is pinned
 * by `shader_stretch` in processinator's tests/display_test.rs.
 */

import {
  computeMtfSolution,
  type StretchPayload,
} from "./mtf-solution";

const VERT_SRC = `#version 300 es
const vec2 POS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  // Flip Y: data row 0 is the image's top row
  vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform bool uIsColor;
uniform vec3 uShadows;
uniform float uScale;
uniform float uMidtone;
uniform float uGreenRemoval;
uniform float uSaturation;

float mtf(float m, float x) {
  float denom = (2.0 * m - 1.0) * x - m;
  if (abs(denom) < 1e-10) return x;
  return clamp((m - 1.0) * x / denom, 0.0, 1.0);
}

void main() {
  if (uIsColor) {
    vec3 v = clamp((texture(uTex, vUv).rgb - uShadows) * uScale, 0.0, 1.0);
    vec3 s = vec3(mtf(uMidtone, v.r), mtf(uMidtone, v.g), mtf(uMidtone, v.b));
    // SCNR-style green suppression (average-neutral)
    float neutral = (s.r + s.b) * 0.5;
    if (s.g > neutral) s.g -= uGreenRemoval * (s.g - neutral);
    // Saturation around per-pixel luminance
    float lum = (s.r + s.g + s.b) / 3.0;
    s = clamp(lum + uSaturation * (s - lum), 0.0, 1.0);
    outColor = vec4(s, 1.0);
  } else {
    float v = clamp((texture(uTex, vUv).r - uShadows.x) * uScale, 0.0, 1.0);
    float s = mtf(uMidtone, v);
    outColor = vec4(s, s, s, 1.0);
  }
}
`;

export class StretchRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private payload: StretchPayload;
  private loc: Record<string, WebGLUniformLocation | null>;

  /** Throws if a WebGL2 context can't be created (caller falls back). */
  constructor(canvas: HTMLCanvasElement, payload: StretchPayload) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 context creation failed");
    this.gl = gl;
    this.payload = payload;

    canvas.width = payload.width;
    canvas.height = payload.height;
    gl.viewport(0, 0, payload.width, payload.height);

    this.program = buildProgram(gl, VERT_SRC, FRAG_SRC);
    this.loc = Object.fromEntries(
      [
        "uTex",
        "uIsColor",
        "uShadows",
        "uScale",
        "uMidtone",
        "uGreenRemoval",
        "uSaturation",
      ].map((name) => [name, gl.getUniformLocation(this.program, name)]),
    );

    this.texture = uploadTexture(gl, payload);

    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.loc.uTex, 0);
    gl.uniform1i(this.loc.uIsColor, payload.channels > 1 ? 1 : 0);
    gl.uniform1f(this.loc.uGreenRemoval, payload.channels > 1 ? payload.greenRemoval : 0);
    gl.uniform1f(this.loc.uSaturation, payload.channels > 1 ? payload.saturation : 1);
  }

  /** Recompute the solution for these parameters and redraw. */
  setParams(bgPercent: number, sigma: number): void {
    const { gl } = this;
    const sol = computeMtfSolution(this.payload, bgPercent, sigma);
    gl.useProgram(this.program);
    gl.uniform3f(this.loc.uShadows, sol.shadows[0], sol.shadows[1], sol.shadows[2]);
    gl.uniform1f(this.loc.uScale, sol.scale);
    gl.uniform1f(this.loc.uMidtone, sol.midtone);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
    // Release GPU memory promptly rather than waiting for GC of the canvas
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function uploadTexture(gl: WebGL2RenderingContext, payload: StretchPayload): WebGLTexture {
  const { width, height, channels, pixels } = payload;
  const plane = width * height;

  const tex = gl.createTexture();
  if (!tex) throw new Error("texture allocation failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);

  // Linear filtering on float textures needs an extension; fall back to
  // nearest (only affects display scaling, not stretch math)
  const filter = gl.getExtension("OES_texture_float_linear")
    ? gl.LINEAR
    : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  if (channels > 1) {
    // Interleave planar RGB → RGBA (RGB32F isn't a supported upload combo)
    const rgba = new Float32Array(plane * 4);
    for (let i = 0; i < plane; i++) {
      rgba[i * 4] = pixels[i];
      rgba[i * 4 + 1] = pixels[plane + i];
      rgba[i * 4 + 2] = pixels[plane * 2 + i];
      rgba[i * 4 + 3] = 1;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, rgba);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, pixels);
  }

  if (gl.getError() !== gl.NO_ERROR) {
    gl.deleteTexture(tex);
    throw new Error("float texture upload failed");
  }
  return tex;
}

function buildProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("shader allocation failed");
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`shader compile failed: ${log}`);
    }
    return shader;
  };

  const vert = compile(gl.VERTEX_SHADER, vertSrc);
  const frag = compile(gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("program allocation failed");
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log}`);
  }
  return program;
}
