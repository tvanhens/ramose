struct Params {
  time: f32,
  aspect: f32,
  pointer: vec2f,
}

@group(0) @binding(0) var<uniform> params: Params;

fn hash21(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn packet(edgeId: vec2f, along: f32, time: f32) -> f32 {
  let seed = hash21(edgeId);
  let density = step(0.85, hash21(edgeId + vec2f(43.2, 81.7)));
  let cycle = fract(time * (0.042 + seed * 0.012) + seed * 8.31);
  let duration = 0.235;
  let activity = (1.0 - step(duration, cycle)) * density;
  let head = cycle / duration;
  let direction = step(0.5, hash21(edgeId + vec2f(6.4, 29.8)));
  let edgePosition = mix(along, 1.0 - along, direction);
  let behind = head - edgePosition;
  let core = exp(-pow((edgePosition - head) * 31.0, 2.0));
  let tail = exp(-behind * 8.5) * step(0.0, behind) * step(behind, 0.38);
  let fade = smoothstep(0.0, 0.09, head) * (1.0 - smoothstep(0.87, 1.0, head));
  return activity * fade * (core + tail * 0.5);
}

fn rowParity(row: f32) -> f32 {
  return row - floor(row * 0.5) * 2.0;
}

fn nodePosition(id: vec2f, time: f32) -> vec2f {
  let seedX = hash21(id * vec2f(1.73, 2.37) + vec2f(4.19, 8.73));
  let seedY = hash21(id * vec2f(2.91, 1.41) + vec2f(7.31, 3.17));
  let seedSpeed = hash21(id + vec2f(31.7, 19.3));
  let fixedJitter = (vec2f(seedX, seedY) - 0.5) * vec2f(0.56, 0.38);
  let drift = vec2f(
    sin(time * (0.12 + seedSpeed * 0.32) + seedX * 6.2831),
    cos(time * (0.1 + seedX * 0.3) + seedY * 6.2831)
  ) * vec2f(0.19, 0.15);
  let stagger = rowParity(id.y) * 0.5;
  return vec2f(id.x + stagger, id.y * 0.8660254) + fixedJitter + drift;
}

fn edgeDistance(p: vec2f, a: vec2f, b: vec2f) -> vec2f {
  let edge = b - a;
  let along = clamp(dot(p - a, edge) / dot(edge, edge), 0.0, 1.0);
  return vec2f(length(p - (a + edge * along)), along);
}

fn bridgeTriangle(id: vec2f, time: f32) -> f32 {
  let rowPhase = floor(hash21(vec2f(id.y, 17.31)) * 4.0);
  let staggeredColumn = id.x + rowPhase;
  let positiveModulo = staggeredColumn - floor(staggeredColumn / 4.0) * 4.0;
  let requiredBridge = 1.0 - step(0.5, positiveModulo);
  let connectionSeed = hash21(id * vec2f(3.17, 2.41) + vec2f(8.7, 4.3));
  let connectionCycle = fract(
    time * (0.025 + connectionSeed * 0.035) + connectionSeed * 9.73
  );
  let connectionForms = step(0.12, connectionCycle);
  let connectionBreaks = 1.0 - step(0.78, connectionCycle);
  let organicBridge = step(0.58, connectionSeed) * connectionForms * connectionBreaks;
  return max(requiredBridge, organicBridge);
}

fn addEdge(
  p: vec2f,
  a: vec2f,
  b: vec2f,
  edgeId: vec2f,
  presence: f32,
  time: f32
) -> vec3f {
  let edge = edgeDistance(p, a, b);
  let base = exp(-edge.x * 148.0);
  let moving = packet(edgeId, edge.y, time);
  let hot = moving * exp(-edge.x * 255.0);
  let glow = moving * exp(-edge.x * 12.0);
  return vec3f(base, hot, glow) * presence;
}

fn addNodeEdges(p: vec2f, id: vec2f, time: f32) -> vec4f {
  let origin = nodePosition(id, time);
  let right = nodePosition(id + vec2f(1.0, 0.0), time);
  let parity = rowParity(id.y);
  let downLeftId = id + vec2f(parity - 1.0, 1.0);
  let downRightId = id + vec2f(parity, 1.0);
  let downLeft = nodePosition(downLeftId, time);
  let downRight = nodePosition(downRightId, time);
  // Horizontal chains guarantee degree >= 2. Staggered closed triangles join
  // every row to the next, making one connected graph without filling every
  // possible edge in the underlying triangular lattice.
  let rightPresence = 1.0;
  let leftPresence = bridgeTriangle(id - vec2f(1.0, 0.0), time);
  let downPresence = bridgeTriangle(id, time);

  var edges = vec3f(0.0);
  edges += addEdge(p, origin, right, id * 11.0 + vec2f(0.17, 0.31), rightPresence, time);
  edges += addEdge(p, origin, downLeft, id * 11.0 + vec2f(3.73, 5.19), leftPresence, time);
  edges += addEdge(p, origin, downRight, id * 11.0 + vec2f(7.41, 9.13), downPresence, time);
  let nodePresence = max(rightPresence, max(leftPresence, downPresence));
  let nodeGlow = exp(-length(p - origin) * 82.0) * nodePresence;
  return vec4f(edges, nodeGlow);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let time = params.time;
  // An affine tilt keeps every connection straight; only its endpoint nodes
  // move, each with independent direction, speed, and phase.
  var world = vec2f(
    (uv.x - 0.5) * params.aspect * 6.36 + (uv.y - 0.5) * 0.32,
    uv.y * 5.37 - 0.15
  );
  world.x += params.pointer.x * 0.12;
  world.y += params.pointer.y * 0.08;

  let baseRow = floor(world.y / 0.8660254);
  let baseColumn = floor(world.x - rowParity(baseRow) * 0.5);
  var graphData = vec4f(0.0);

  // Neighboring ownership keeps straight segments seamless even as endpoints
  // wander across their nominal triangular cells.
  for (var rowIndex: i32 = -1; rowIndex <= 1; rowIndex = rowIndex + 1) {
    for (var columnIndex: i32 = -2; columnIndex <= 2; columnIndex = columnIndex + 1) {
      let id = vec2f(
        baseColumn + f32(columnIndex),
        baseRow + f32(rowIndex)
      );
      graphData += addNodeEdges(world, id, time);
    }
  }

  let graph = graphData.xyz;
  let nodes = graphData.w;

  let centerGlow = exp(-length((uv - vec2f(0.68, 0.42)) * vec2f(1.15, 1.0)) * 4.2);
  let vignette = smoothstep(0.92, 0.17, length((uv - 0.5) * vec2f(0.78, 1.0)));
  let horizonFade = smoothstep(0.02, 0.24, uv.y) * (1.0 - smoothstep(0.8, 1.0, uv.y));

  let baseColor = vec3f(0.006, 0.0045, 0.0035) + vec3f(0.018, 0.006, 0.001) * centerGlow;
  let meshColor = vec3f(0.48, 0.15, 0.045) * (graph.x * 0.38 + nodes * 0.28);
  let packetColor = vec3f(1.0, 0.245, 0.018) * graph.y * 1.25;
  let warmBloom = vec3f(0.72, 0.105, 0.004) * graph.z * 0.34;
  let color = baseColor + (meshColor + packetColor + warmBloom) * horizonFade * vignette;

  return vec4f(color, 1.0);
}
