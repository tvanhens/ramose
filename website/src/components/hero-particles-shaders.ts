/**
 * WGSL for the landing-page hero particle animation.
 *
 * Two shader modules share one particle state: a fullscreen fragment pass
 * that advances a WIDTH x WIDTH rgba32float position/velocity texture
 * (ping-pong), and a point-list pass that draws one additively blended 1px
 * point per texel. Both modules embed the same hash/noise and choreography
 * blocks below, so phase timing and per-particle hashes cannot drift apart.
 *
 * The choreography constants are tuned as a set; see the timeline comment on
 * the phase block before changing any of them.
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

/**
 * Choreography shared by the sim and draw passes: the 36s cycle timeline,
 * the logo rotation, and the morphing network graph.
 */
const PHASE_WGSL = /* wgsl */ `
  fn phaseCyc(time: f32) -> f32 { return fract(time / 36.0); }

  // 36s timeline — clouds are only brief beats between organized states:
  //   graph coalesces over ~5s (0.03-0.17, pulses/motion live the whole
  //   way) · fully formed 0.17-0.25 (~3s) · melts 0.25-0.35 · quick cloud
  //   0.35-0.39 · logo rotation+assembly 0.39-0.775 · crisp, still
  //   turning, near 0.79 · melting 0.8-0.91 · quick cloud to wrap.
  fn sLogo(time: f32) -> f32 {
    let c = phaseCyc(time);
    return smoothstep(0.4, 0.775, c) * (1.0 - smoothstep(0.8, 0.91, c));
  }

  fn sNet(time: f32) -> f32 {
    let c = phaseCyc(time);
    return smoothstep(0.03, 0.17, c) * (1.0 - smoothstep(0.25, 0.35, c));
  }

  fn markTheta(time: f32, inner: f32) -> f32 {
    // The rotation never stops: the window runs through the melt,
    // decelerating to a slow but nonzero turn. Turn counts are scaled so
    // both squares pass exactly through face-on at the crisp moment
    // (p = 0.769, cyc ~0.79), then keep drifting as the logo dissolves.
    let p = clamp((phaseCyc(time) - 0.39) / 0.52, 0.0, 1.0);
    let ease = mix(p, 1.0 - (1.0 - p) * (1.0 - p), 0.6);
    // Different magnitudes, opposite signs (equal-and-opposite reads as
    // synchronized in projection). The small sine sway keeps the logo
    // breathing on top of the drift.
    let turns = mix(-2.283, 3.4245, inner);
    return 6.2831853 * turns * ease + 0.05 * sin(time * 0.7 + inner * 2.1);
  }

  // Morphing triangular graph: staggered 7x5 lattice whose nodes wander
  // on slow noise, so the graph deforms organically while staying a graph.
  fn netNode(col: f32, row: f32, time: f32, aspect: f32) -> vec2f {
    // The lattice only fixes topology; positions are heavily randomized.
    // Each 36s epoch reshuffles the layout (invisible: the swap happens
    // mid-cloud-phase, while sNet is zero), and nodes glide continuously on
    // noise while the graph is up, so it reads as a random organic graph,
    // never the same twice.
    let epoch = floor(time / 36.0);
    let stagger = (row - floor(row * 0.5) * 2.0) * 0.5;
    // Overscanned: outer nodes sit past the frame so the graph never
    // feels contained by the viewport.
    let base = vec2f(
      ((col + stagger) / 6.0 - 0.5) * 2.0 * aspect * 1.15,
      ((row + 0.5) / 5.0 - 0.5) * 2.0 * 1.15
    );
    let id = vec2f(col + epoch * 13.7, row + epoch * 7.9);
    let jitter = vec2f(hash21(id + vec2f(1.2, 8.4)), hash21(id + vec2f(6.6, 2.3))) - 0.5;
    let wander = vec2f(
      fbm(vec2f(col * 1.7 + 0.3, row * 2.3) + epoch * 3.1 + time * 0.05) - 0.5,
      fbm(vec2f(row * 1.9 + 5.1, col * 1.3) + epoch * 5.7 + time * 0.045 + 9.7) - 0.5
    ) * 0.42;
    return base + jitter * 0.34 + wander;
  }

  // Each particle lives on one lattice edge: right, down-left or down-right
  // from its home node. Returns (col, row, col2, row2).
  fn netEdge(seed: vec2f) -> vec4f {
    let col = floor(hash21(seed + vec2f(3.3, 1.7)) * 7.0);
    let row = floor(hash21(seed + vec2f(8.1, 4.9)) * 5.0);
    let dir = floor(hash21(seed + vec2f(6.7, 2.9)) * 3.0);
    let parity = row - floor(row * 0.5) * 2.0;
    var c2 = col + 1.0;
    var r2 = row;
    if (dir > 0.5 && dir < 1.5) { c2 = col + parity - 1.0; r2 = row + 1.0; }
    if (dir >= 1.5) { c2 = col + parity; r2 = row + 1.0; }
    // Redirect out-of-range neighbors inward so no edge degenerates into a
    // point (degenerate a==b edges render as garbage perpendicular dashes).
    if (c2 > 6.0) { c2 = col - 1.0; }
    if (c2 < 0.0) { c2 = col + 1.0; }
    if (r2 > 4.0) { r2 = row - 1.0; }
    return vec4f(col, row, c2, r2);
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
  PHASE_WGSL +
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
    let dt = u.dt;
    let aspect = u.aspect;
    let sL = sLogo(time);
    let sN = sNet(time);

    // Free drift from a slowly evolving curl field.
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

    // Network phase: a partial, ever-changing graph. Each edge has a life
    // cycle (fades in, lingers, fades out, staggered per edge) so the graph
    // is never fully connected; particles whose edge is currently down fall
    // back to cloud behavior. A loose spring plus per-particle perpendicular
    // scatter keeps edges as fuzzy particle bands, not resolved lines.
    let eg = netEdge(seed);
    let na = netNode(eg.x, eg.y, time, aspect);
    let nb = netNode(eg.z, eg.w, time, aspect);
    let tE = hash21(seed + vec2f(9.9, 0.3));
    let edgeVec = nb - na + vec2f(1e-4, 0.0);
    let edgePerp = normalize(vec2f(-edgeVec.y, edgeVec.x));
    // Thin bands with per-edge character: each edge has its own width and
    // particle density (close but not uniform), and the triangular scatter
    // distribution gives a dense core with feathered borders.
    let widthK = 0.55 + 0.9 * hash21(eg.xy * 2.6 + eg.zw * 8.8);
    let scatter = (hash21(seed + vec2f(0.7, 5.5)) + hash21(seed + vec2f(5.2, 1.1)) - 1.0) * 0.005 * widthK;
    let netT = mix(na, nb, tE) + edgePerp * scatter;
    let ePhase = fract(hash21(eg.xy * 3.7 + eg.zw * 1.9) + time * 0.014);
    let dens = step(hash21(seed + vec2f(4.4, 7.2)), 0.55 + 0.45 * hash21(eg.xy * 1.9 + eg.zw * 5.3));
    let presence = smoothstep(0.05, 0.25, ePhase) * (1.0 - smoothstep(0.75, 0.95, ePhase)) * dens;
    let sNp = sN * presence;
    let s = max(sL, sNp);

    // Residual drift never fully dies, so even the held logo keeps a
    // faint shimmer of motion.
    var accel = drift * 0.12 * (1.0 - s * 0.85);
    accel += (goal - pos) * sL * 9.0;
    // Edge thinness is limited by spring lag, not just scatter: this spring
    // constant and the node-wander speeds are tuned together.
    accel += (netT - pos) * sNp * 11.0;
    accel -= vel * (0.55 + s * 5.5);

    // Free phase: each particle belongs to one of six slowly wandering
    // vortices — weak attraction plus a tangential swirl (spin direction
    // alternating per vortex) organizes the dispersed particles into
    // several distinct turbulent clouds instead of a uniform haze.
    let freeS = 1.0 - s;
    // Cluster membership slowly migrates: each particle re-rolls its vortex
    // roughly once a minute, staggered, so streams of particles trade
    // between clouds instead of the same six populations reforming forever.
    let k = floor(fract(hash21(seed + vec2f(5.9, 12.3)) + time * 0.004) * 6.0);
    // Centers tour the whole screen on incommensurate two-sine paths — the
    // composition never repeats on any cycle-length timescale.
    let ck = vec2f(
      (sin(time * 0.047 + k * 4.13) * 0.62 + sin(time * 0.0211 + k * 1.91) * 0.42) * aspect,
      cos(time * 0.039 + k * 2.71) * 0.5 + sin(time * 0.0257 + k * 5.37) * 0.38
    );
    // Organic deformation: the attractor each particle chases is warped by
    // position-dependent noise, so clouds are ragged tendrilled blobs, not
    // disks; and each vortex waxes and wanes on its own slow cycle, so
    // clouds continually dissolve and reform.
    let wob = vec2f(
      fbm(pos * 1.3 + vec2f(time * 0.05, k * 3.7)) - 0.5,
      fbm(pos * 1.3 + vec2f(k * 5.1, time * 0.06) + 7.3) - 0.5
    ) * 0.9;
    let liveK = clamp(0.55 + 0.95 * sin(time * (0.13 + k * 0.031) + k * 2.61), 0.05, 1.4);
    let toC = (ck + wob) - pos;
    let dC = max(length(toC), 0.08);
    let dirC = toC / dC;
    let spinDir = mix(1.0, -1.0, step(0.5, hash21(vec2f(k, 9.4))));
    let tangC = vec2f(-dirC.y, dirC.x) * spinDir;
    // Velocity steering, not force pumping: each particle chases a target
    // spiral-inflow velocity around its vortex. Constant tangential forcing
    // would pump orbits out to off-screen radii; steering bounds them, and
    // per-particle weights spread the settled radii into fuzzy filled disks.
    let wAttract = 0.5 + 1.0 * hash21(seed + vec2f(2.2, 6.6));
    let wSwirl = 0.4 + 1.2 * hash21(seed + vec2f(8.8, 0.7));
    let swirlV = tangC * (0.7 * wSwirl / (1.0 + dC * dC * 4.0));
    let inV = dirC * (0.45 * wAttract * clamp(dC * 2.0, 0.3, 1.0));
    let gain = (0.7 + 0.6 * hash21(seed + vec2f(6.4, 3.9))) * liveK;
    accel += ((swirlV + inV) - vel) * freeS * 1.6 * gain;
    // A second, finer-scale curl field keeps the interiors churning.
    let np2 = pos * 2.6 + vec2f(time * 0.07, -time * 0.05);
    let drift2 = vec2f(
      fbm(np2 + vec2f(0.0, e)) - fbm(np2 - vec2f(0.0, e)),
      -(fbm(np2 + vec2f(e, 0.0)) - fbm(np2 - vec2f(e, 0.0)))
    ) / (2.0 * e);
    accel += drift2 * 0.3 * freeS;

    // Gentle pointer repulsion; force decays on the CPU side.
    let pd = pos - u.pointer;
    accel += pd * exp(-dot(pd, pd) * 14.0) * u.pointerForce * 3.0;

    vel += accel * dt;
    pos += vel * dt;

    // Soft wrap, wide enough to cover the overscanned graph nodes
    // (lattice scale 1.15 plus wander and jitter) so no organized particle
    // ever wraps and streaks across the frame.
    let bound = vec2f(aspect * 1.45, 1.45);
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
  PHASE_WGSL +
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

    // Depth cue while converged: recompute this particle's rotated z and
    // brighten the near side of each solid, dim the far side.
    let g = textureLoad(goals, xy, 0);
    let th = markTheta(u.time, g.z);
    let z3 = g.x * sin(th) + g.w * cos(th);
    let s = sLogo(u.time);
    let depthShade = clamp(1.15 - z3 * 2.4, 0.2, 1.7);
    fade *= mix(1.0, depthShade, s);

    // Ember orange in the cloud; the outer square resolves to white as the
    // logo assembles (the mark's stroke is currentColor on the site).
    let ember = vec3f(0.55, 0.16, 0.03);
    let stroke = vec3f(0.30, 0.29, 0.28);
    var tint = mix(ember, stroke, s * (1.0 - g.z));

    // Network phase: a bright packet travels along each edge; particles
    // light up hot as it passes.
    let sN = sNet(u.time);
    if (sN > 0.001) {
      let eg = netEdge(seed);
      let tE = hash21(seed + vec2f(9.9, 0.3));
      // Same edge life cycle as the sim: particles on a downed edge are in
      // cloud mode and keep their normal cloud brightness.
      let ePhase = fract(hash21(eg.xy * 3.7 + eg.zw * 1.9) + u.time * 0.014);
      let dens = step(hash21(seed + vec2f(4.4, 7.2)), 0.55 + 0.45 * hash21(eg.xy * 1.9 + eg.zw * 5.3));
      let presence = smoothstep(0.05, 0.25, ePhase) * (1.0 - smoothstep(0.75, 0.95, ePhase)) * dens;
      let sNp = sN * presence;
      let edgeSeed = hash21(eg.xy * 7.3 + eg.zw * 3.1);
      let flowDir = mix(1.0, -1.0, step(0.5, hash21(eg.xy + eg.zw * 2.7)));
      let front = fract(u.time * 0.22 * flowDir + edgeSeed * 7.9);
      let dP = abs(fract(tE - front + 0.5) - 0.5);
      let pulse = exp(-dP * dP * 220.0);
      fade *= mix(1.0, 0.6 + 1.5 * pulse, sNp);
      tint += vec3f(0.45, 0.08, 0.0) * pulse * sNp;
    }

    out.fade = fade;
    out.tint = tint;
    return out;
  }

  @fragment fn fs(@location(0) fade: f32, @location(1) tint: vec3f) -> @location(0) vec4f {
    return vec4f(tint * BRIGHTNESS * fade, 1.0);
  }
`;
