/**
 * WGSL for the landing-page hero particle animation.
 *
 * Two shader modules share one particle state: a fullscreen fragment pass
 * that advances a WIDTH x WIDTH rgba32float position/velocity texture
 * (ping-pong), and a point-list pass that draws one additively blended 1px
 * point per texel. Both modules embed the same hash/noise and rotation
 * blocks below, so per-particle hashes and angles cannot drift apart.
 *
 * The animation is a single continuous state: the extruded Ramose mark as a
 * slowly counter-rotating particle swarm — most particles track their home
 * point on the mark with individually varying stiffness, and a small stray
 * fraction floats loosely around it as an ambient halo.
 */

/** Hash / value-noise / fbm helpers shared by the sim and draw passes. */
const HASH_WGSL = /* wgsl */ `
  fn hash21(p: vec2f) -> f32 {
    let h = dot(p, vec2f(127.1, 311.7));
    return fract(sin(h) * 43758.5453123);
  }
  fn noise2(p: vec2f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash21(i);
    let b = hash21(i + vec2f(1.0, 0.0));
    let c = hash21(i + vec2f(0.0, 1.0));
    let d = hash21(i + vec2f(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  fn fbm(p: vec2f) -> f32 {
    var v = 0.0;
    var amp = 0.5;
    var q = p;
    for (var k = 0; k < 4; k++) {
      v += amp * noise2(q);
      q = q * 2.03 + vec2f(11.3, 7.7);
      amp *= 0.5;
    }
    return v;
  }
`;

/** The mark's rotation, shared by the sim and draw passes. */
const ROTATION_WGSL = /* wgsl */ `
  fn markTheta(time: f32, inner: f32) -> f32 {
    // Continuous counter-rotation. Different magnitudes, opposite signs:
    // equal-and-opposite rates foreshorten in sync and read as spinning
    // together in projection. The small sine sway keeps the mark breathing
    // on top of the steady turn.
    let turnsPerSecond = mix(-0.03, 0.045, inner);
    return 6.2831853 * turnsPerSecond * time + 0.05 * sin(time * 0.7 + inner * 2.1);
  }
`;

/**
 * Uniforms shared by both passes. Layout is 32 bytes; keep in sync with
 * UNIFORM_FLOATS / the Float32Array written each substep in hero-particles.ts.
 */
const UNIFORMS_WGSL = /* wgsl */ `
  struct Uniforms {
    time: f32,
    dt: f32,
    aspect: f32,
    pointerForce: f32,
    pointer: vec2f,     // pointer position, world coordinates
    markCenter: vec2f,  // logo center, world coordinates
  }
`;

/**
 * Simulation pass: fullscreen triangle over the state texture. Each texel is
 * one particle; reads the previous state plus the per-particle goal (its home
 * on the extruded Ramose mark) and writes the integrated position/velocity.
 *
 * NOTE: every declared binding is genuinely read. With layout: "auto",
 * WebGPU drops bindings a shader never uses and the bind group that still
 * includes them becomes invalid.
 */
export const SIM_SHADER_WGSL =
  HASH_WGSL +
  ROTATION_WGSL +
  UNIFORMS_WGSL +
  /* wgsl */ `
  @group(0) @binding(0) var<uniform> u: Uniforms;
  @group(0) @binding(1) var prev: texture_2d<f32>;
  @group(0) @binding(2) var goals: texture_2d<f32>;

  struct VOut { @builtin(position) pos: vec4f }

  @vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
    var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var out: VOut;
    out.pos = vec4f(p[i], 0.0, 1.0);
    return out;
  }

  @fragment fn fs(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
    let xy = vec2i(fragPos.xy);
    let state = textureLoad(prev, xy, 0);
    var pos = state.xy;
    var vel = state.zw;
    // Texel-center seed; the draw pass derives the identical seed from the
    // vertex index so per-particle hashes agree between the two shaders.
    let seed = fragPos.xy;
    let time = u.time;

    // Shimmer from a slowly evolving curl field.
    let e = 0.11;
    let np = pos * 0.9 + hash21(seed) * 0.13;
    let drift = vec2f(
      fbm(np + vec2f(0.0, e) + time * 0.02) - fbm(np - vec2f(0.0, e) + time * 0.02),
      -(fbm(np + vec2f(e, 0.0) + time * 0.02) - fbm(np - vec2f(e, 0.0) + time * 0.02))
    ) / (2.0 * e);

    // Rotate the mark-local goal around its vertical axis: outer square one
    // way, inner diamond the other, with a perspective foreshortening.
    let g = textureLoad(goals, xy, 0);
    let th = markTheta(time, g.z);
    let x3 = g.x * cos(th) - g.w * sin(th);
    let z3 = g.x * sin(th) + g.w * cos(th);
    let persp = 1.0 / (1.0 + z3 * 0.5);
    let goal = u.markCenter + vec2f(x3, g.y) * persp;

    // Swarm character: spring stiffness varies per particle (soft laggards
    // smear behind the turn, stiff ones hold the form), and a small stray
    // fraction barely tracks the mark at all, floating around it as a
    // drifting halo.
    let springK = 9.0 * (0.45 + 0.9 * hash21(seed + vec2f(2.2, 6.6)));
    let stray = smoothstep(0.86, 1.0, hash21(seed + vec2f(8.8, 0.7)));
    var accel = drift * mix(0.06, 0.55, stray);
    accel += (goal - pos) * springK * mix(1.0, 0.12, stray);
    accel -= vel * 5.5;

    // Gentle pointer repulsion; force decays on the CPU side.
    let pd = pos - u.pointer;
    accel += pd * exp(-dot(pd, pd) * 14.0) * u.pointerForce * 3.0;

    vel += accel * u.dt;
    pos += vel * u.dt;

    // Soft wrap safety net, generous enough that strays never visibly
    // teleport at a frame edge.
    let bound = vec2f(u.aspect * 1.45, 1.45);
    pos = ((pos + bound) - floor((pos + bound) / (2.0 * bound)) * (2.0 * bound)) - bound;

    return vec4f(pos, vel);
  }
`;

/**
 * Draw pass: one vertex per state texel, rendered as additive 1px points.
 * STATE_SIZE is a pipeline override; the host passes the same value it used
 * to size the state texture.
 */
export const DRAW_SHADER_WGSL =
  HASH_WGSL +
  ROTATION_WGSL +
  UNIFORMS_WGSL +
  /* wgsl */ `
  override STATE_SIZE: u32 = 512u;
  // Per-particle brightness; the host raises it on lower particle tiers so
  // small screens keep a present, legible animation instead of a faint one.
  override BRIGHTNESS: f32 = 0.16;

  @group(0) @binding(0) var<uniform> u: Uniforms;
  @group(0) @binding(1) var state: texture_2d<f32>;
  @group(0) @binding(2) var goals: texture_2d<f32>;

  struct VOut { @builtin(position) pos: vec4f, @location(0) fade: f32, @location(1) tint: vec3f }

  @vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
    let xy = vec2i(i32(i % STATE_SIZE), i32(i / STATE_SIZE));
    // Matches the sim pass's fragPos.xy (texel centers) so per-particle
    // hashes agree between the two shaders.
    let seed = vec2f(xy) + 0.5;
    let st = textureLoad(state, xy, 0);
    var out: VOut;
    out.pos = vec4f(st.x / u.aspect, st.y, 0.0, 1.0);
    let speed = length(st.zw);
    var fade = clamp(0.35 + speed * 1.4, 0.35, 1.0);

    // Depth cue: recompute this particle's rotated z and brighten the near
    // side of each solid, dim the far side.
    let g = textureLoad(goals, xy, 0);
    let th = markTheta(u.time, g.z);
    let z3 = g.x * sin(th) + g.w * cos(th);
    fade *= clamp(1.15 - z3 * 2.4, 0.2, 1.7);

    // The outer square is white (the mark's stroke is currentColor on the
    // site); the inner diamond keeps the ember orange.
    let ember = vec3f(0.55, 0.16, 0.03);
    let stroke = vec3f(0.30, 0.29, 0.28);
    out.fade = fade;
    out.tint = mix(ember, stroke, 1.0 - g.z);
    return out;
  }

  @fragment fn fs(@location(0) fade: f32, @location(1) tint: vec3f) -> @location(0) vec4f {
    return vec4f(tint * BRIGHTNESS * fade, 1.0);
  }
`;
