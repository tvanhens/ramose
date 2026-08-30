/**
 * WebGPU runtime for the landing-page hero: the extruded Ramose mark as a
 * slowly counter-rotating particle swarm. Shader source and the motion
 * tuning live in hero-particles-shaders.ts.
 *
 * Written against raw WebGPU: the sim needs rgba32float ping-pong render
 * targets seeded via writeTexture and a point-list pipeline with additive
 * blending, none of which vgpu 0.3.1 exposes.
 */

import markSvgSource from "../assets/ramose-mark.svg?raw";
import { DRAW_SHADER_WGSL, SIM_SHADER_WGSL } from "./hero-particles-shaders";

export interface HeroParticlesOptions {
  /**
   * Called (at most once, never re-entrantly with startHeroParticles) when
   * the GPU device is lost or errors after a successful start. Resources are
   * already released; the host should fall back to the static artwork.
   */
  onLost?: (reason: string) => void;
}

export interface HeroParticlesHandle {
  /** Stops the loop and releases all GPU resources. Safe to call twice. */
  stop: () => void;
}

/** Time scale for the ?hero-pin dev aid (seconds per unit of the pin). */
const PIN_SECONDS = 36;

/** Height of the Ramose mark in world units (world y spans [-1, 1]). */
const MARK_SCALE = 0.92;
/** Mark center: x is multiplied by the live aspect (right of the hero copy). */
const MARK_CENTER = [0.52, 0.02] as const;
/** The mark SVG is rasterized at this resolution to sample goal points. */
const MARK_RASTER_SIZE = 256;

/**
 * Substepping: when frames arrive late (hidden or throttled tab) the sim
 * takes several capped steps per frame so the physics keeps up with the
 * real-time phase clock instead of running in slow motion.
 */
const MAX_STEP_SECONDS = 0.05;
const MAX_SUBSTEPS = 6;

/** Matches the site's near-black hero background. */
const CLEAR_COLOR: GPUColor = [0.006, 0.0045, 0.0035, 1];

const DPR_CAP = 1.5;

/** Floats in the uniform buffer; must match struct Uniforms in the WGSL. */
const UNIFORM_FLOATS = 8;

/**
 * Adaptive quality: side length of the square particle state texture
 * (side² particles), picked from the DPR-adjusted canvas area so small
 * screens push fewer points while keeping a similar on-screen density.
 */
function stateTextureSize(cssWidth: number, cssHeight: number, dpr: number): number {
  const devicePixels = cssWidth * cssHeight * dpr * dpr;
  if (devicePixels >= 1_100_000) return 512; // 262,144 particles
  if (devicePixels >= 500_000) return 384; // 147,456 particles
  return 256; // 65,536 particles
}

/**
 * Rasterizes the Ramose mark and samples it into [x, y, inner] points in
 * 0..255 raster coordinates. The outer stroke is rewritten thicker first so
 * the frame reads as a chunkier solid at particle resolution.
 */
async function rasterizeMarkPoints(): Promise<Array<[number, number, number]>> {
  const thickened = markSvgSource.replace('stroke-width="9"', 'stroke-width="15"');
  const image = new Image();
  image.src = `data:image/svg+xml;base64,${btoa(thickened)}`;
  await image.decode();

  const raster = document.createElement("canvas");
  raster.width = MARK_RASTER_SIZE;
  raster.height = MARK_RASTER_SIZE;
  const context = raster.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable for mark rasterization");
  context.drawImage(image, 0, 0, MARK_RASTER_SIZE, MARK_RASTER_SIZE);

  const { data } = context.getImageData(0, 0, MARK_RASTER_SIZE, MARK_RASTER_SIZE);
  const points: Array<[number, number, number]> = [];
  for (let y = 0; y < MARK_RASTER_SIZE; y++) {
    for (let x = 0; x < MARK_RASTER_SIZE; x++) {
      const index = (y * MARK_RASTER_SIZE + x) * 4;
      if (data[index + 3] > 100) {
        // Inner diamond is the orange gradient fill (red channel high);
        // the outer stroke is currentColor, which rasterizes black.
        points.push([x, y, data[index] > 128 ? 1 : 0]);
      }
    }
  }
  if (points.length === 0) throw new Error("Mark rasterization produced no points");
  return points;
}

/**
 * Every particle gets a fixed home on the mark: mark-local x/y (y up, world
 * scaled), an inner/outer flag, and an extruded z that turns the outer square
 * into a tube and the inner diamond into a solid slab as it rotates.
 */
function buildGoalData(size: number, points: Array<[number, number, number]>): Float32Array {
  const goals = new Float32Array(size * size * 4);
  const half = MARK_RASTER_SIZE / 2;
  for (let i = 0; i < size * size; i++) {
    const [markX, markY, inner] = points[(Math.random() * points.length) | 0];
    goals[i * 4] = ((markX + Math.random() - half) / MARK_RASTER_SIZE) * MARK_SCALE;
    goals[i * 4 + 1] = -((markY + Math.random() - half) / MARK_RASTER_SIZE) * MARK_SCALE;
    goals[i * 4 + 2] = inner;
    goals[i * 4 + 3] = (Math.random() - 0.5) * 0.12 * MARK_SCALE;
  }
  return goals;
}

/** Initial state: positions scattered across the visible world, zero velocity. */
function buildSeedData(size: number, aspect: number): Float32Array {
  const seed = new Float32Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    seed[i * 4] = (Math.random() * 2 - 1) * aspect;
    seed[i * 4 + 1] = Math.random() * 2 - 1;
  }
  return seed;
}

/**
 * Dev aid: ?hero-pin=0.5 pins the animation clock (in units of PIN_SECONDS)
 * so any rotation angle can be inspected statically (dt still flows, so the
 * particles settle into the pinned pose).
 */
function frozenTime(): number | null {
  const raw = new URLSearchParams(location.search).get("hero-pin");
  if (raw === null) return null;
  const pin = Number.parseFloat(raw);
  return Number.isFinite(pin) ? pin * PIN_SECONDS : null;
}

export async function startHeroParticles(
  canvas: HTMLCanvasElement,
  hero: HTMLElement,
  options: HeroParticlesOptions = {},
): Promise<HeroParticlesHandle> {
  // Layout gate: before the page styles apply (dev-server CSS races) the
  // canvas can transiently measure as a 1px-wide, document-tall strip.
  // Sizing the swap chain, picking the particle tier, or seeding particle
  // positions from that measurement produces garbage, so wait for a
  // plausible layout first. Hidden documents deliver it with their first
  // rendered frame.
  await new Promise<void>((resolve) => {
    const plausible = () => canvas.clientWidth >= 8 && canvas.clientHeight >= 8;
    if (plausible()) return resolve();
    const observer = new ResizeObserver(() => {
      if (plausible()) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(canvas);
  });

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  let cssWidth = Math.max(1, canvas.clientWidth);
  let cssHeight = Math.max(1, canvas.clientHeight);

  let stopped = false;
  const cleanups: Array<() => void> = [() => device.destroy()];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanups.reverse()) cleanup();
  };
  const fail = (reason: string) => {
    if (stopped) return;
    stop();
    options.onLost?.(reason);
  };
  void device.lost.then((info) => {
    if (info.reason !== "destroyed") fail(`WebGPU device lost: ${info.message}`);
  });
  device.addEventListener("uncapturederror", (event) => {
    fail(`WebGPU error: ${event.error.message}`);
  });

  try {
    const size = stateTextureSize(cssWidth, cssHeight, dpr);

    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("No WebGPU canvas context");
    const surfaceFormat = navigator.gpu.getPreferredCanvasFormat();
    // Clamp to the device's texture limit: before the page styles apply the
    // canvas can transiently measure as tall as the whole document (dev-mode
    // CSS races), and an oversized swap chain is a validation error. The
    // ResizeObserver below corrects the size once real layout lands.
    const maxDim = device.limits.maxTextureDimension2D;
    const applyCanvasSize = () => {
      canvas.width = Math.min(maxDim, Math.max(1, Math.floor(cssWidth * dpr)));
      canvas.height = Math.min(maxDim, Math.max(1, Math.floor(cssHeight * dpr)));
    };
    applyCanvasSize();
    context.configure({ device, format: surfaceFormat, alphaMode: "opaque" });
    cleanups.push(() => context.unconfigure());

    // Particle state: position + velocity per texel, ping-ponged between two
    // rgba32float textures (non-filterable — the shaders use textureLoad only).
    const stateTextures = [0, 1].map(() =>
      device.createTexture({
        size: [size, size],
        format: "rgba32float",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_DST,
      }),
    );
    const seedData = buildSeedData(size, cssWidth / cssHeight);
    for (const texture of stateTextures) {
      device.queue.writeTexture({ texture }, seedData, { bytesPerRow: size * 16 }, [size, size]);
    }

    const goalTexture = device.createTexture({
      size: [size, size],
      format: "rgba32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const goalData = buildGoalData(size, await rasterizeMarkPoints());
    device.queue.writeTexture({ texture: goalTexture }, goalData, { bytesPerRow: size * 16 }, [
      size,
      size,
    ]);

    const simModule = device.createShaderModule({ code: SIM_SHADER_WGSL });
    const simPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: simModule, entryPoint: "vs" },
      fragment: { module: simModule, entryPoint: "fs", targets: [{ format: "rgba32float" }] },
      primitive: { topology: "triangle-list" },
    });

    const drawModule = device.createShaderModule({ code: DRAW_SHADER_WGSL });
    const drawPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: drawModule,
        entryPoint: "vs",
        constants: { STATE_SIZE: size },
      },
      fragment: {
        module: drawModule,
        entryPoint: "fs",
        // Lower particle tiers spread fewer points over the same shapes;
        // scaling brightness by the tier ratio (plus a small extra boost)
        // keeps the animation present on small screens.
        constants: {
          BRIGHTNESS: 0.16 * (512 / size) * (size < 512 ? 1.25 : 1),
        },
        targets: [
          {
            format: surfaceFormat,
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "point-list" },
    });

    const uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const uniformData = new Float32Array(UNIFORM_FLOATS);
    cleanups.push(() => {
      for (const texture of stateTextures) texture.destroy();
      goalTexture.destroy();
      uniformBuffer.destroy();
    });

    const bindEntries = (state: GPUTexture): GPUBindGroupEntry[] => [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: state.createView() },
      { binding: 2, resource: goalTexture.createView() },
    ];
    const simBindGroups = stateTextures.map((texture) =>
      device.createBindGroup({
        layout: simPipeline.getBindGroupLayout(0),
        entries: bindEntries(texture),
      }),
    );
    const drawBindGroups = stateTextures.map((texture) =>
      device.createBindGroup({
        layout: drawPipeline.getBindGroupLayout(0),
        entries: bindEntries(texture),
      }),
    );

    // The canvas spans the viewport width, so its size tracks the hero layout.
    const resizeObserver = new ResizeObserver(() => {
      cssWidth = Math.max(1, canvas.clientWidth);
      cssHeight = Math.max(1, canvas.clientHeight);
      applyCanvasSize();
    });
    resizeObserver.observe(canvas);
    cleanups.push(() => resizeObserver.disconnect());

    // Pointer repulsion: position in canvas-relative CSS pixels, force built
    // from move speed and decayed every frame.
    const pointer = { active: false, x: 0, y: 0, u: 0.5, v: 0.5, force: 0 };
    const onPointerMove = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      if (pointer.active) {
        const speed = Math.hypot(x - pointer.x, y - pointer.y);
        pointer.force = Math.min(1, pointer.force + speed * 0.02);
      }
      pointer.active = true;
      pointer.x = x;
      pointer.y = y;
      pointer.u = x / Math.max(1, bounds.width);
      pointer.v = y / Math.max(1, bounds.height);
    };
    const onPointerLeave = () => {
      pointer.active = false;
      pointer.force = 0;
    };
    hero.addEventListener("pointermove", onPointerMove, { passive: true });
    hero.addEventListener("pointerleave", onPointerLeave, { passive: true });
    cleanups.push(() => {
      hero.removeEventListener("pointermove", onPointerMove);
      hero.removeEventListener("pointerleave", onPointerLeave);
    });

    let flip = 0;
    const step = (time: number, dt: number) => {
      const aspect = cssWidth / cssHeight;
      const pointerX = pointer.active ? (pointer.u * 2 - 1) * aspect : -1e4;
      const pointerY = pointer.active ? -(pointer.v * 2 - 1) : -1e4;
      uniformData.set([
        time,
        Math.min(dt, MAX_STEP_SECONDS),
        aspect,
        pointer.force,
        pointerX,
        pointerY,
        aspect * MARK_CENTER[0],
        MARK_CENTER[1],
      ]);
      device.queue.writeBuffer(uniformBuffer, 0, uniformData);

      const encoder = device.createCommandEncoder();
      const simPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: stateTextures[1 - flip].createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      simPass.setPipeline(simPipeline);
      simPass.setBindGroup(0, simBindGroups[flip]);
      simPass.draw(3);
      simPass.end();

      const drawPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: CLEAR_COLOR,
          },
        ],
      });
      drawPass.setPipeline(drawPipeline);
      drawPass.setBindGroup(0, drawBindGroups[1 - flip]);
      drawPass.draw(size * size);
      drawPass.end();

      device.queue.submit([encoder.finish()]);
      flip = 1 - flip;
    };

    const pinnedTime = frozenTime();
    let last = performance.now();
    let frameHandle = 0;
    const tick = (now: number) => {
      frameHandle = requestAnimationFrame(tick);
      const dt = (now - last) / 1000;
      last = now;
      // Don't render a hidden page; on return the substeps below catch the
      // sim up with the real-time clock in a few capped steps. A pinned
      // clock (dev aid) renders regardless so pinned poses can be captured
      // from headless or hidden views.
      if (document.hidden && pinnedTime === null) return;
      pointer.force *= 0.9;
      const steps = Math.min(Math.ceil(dt / MAX_STEP_SECONDS), MAX_SUBSTEPS);
      for (let i = 0; i < steps; i++) {
        step(pinnedTime ?? now / 1000, dt / steps);
      }
    };
    frameHandle = requestAnimationFrame(tick);
    cleanups.push(() => cancelAnimationFrame(frameHandle));

    return { stop };
  } catch (error) {
    stop();
    throw error;
  }
}
