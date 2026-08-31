/**
 * Where the browser reaches the `examples/graph` stack.
 *
 * The example owns a real peer Worker and the identity Worker that mints its
 * bearers; the browser lane brings that stack up once and forwards these paths
 * to it, so a test in real Chromium reaches a real Worker, a real Transactor
 * and a real R2 store over the client's own transport.
 */
export const EXAMPLE_ROOT = "example-graph";

/** Where the browser asks the example's identity plane for a bearer. */
export const TOKEN_PATH = "/__example__/token";

/**
 * Where a test cuts one principal's wire to the peer.
 *
 * The peer keeps running: what a partitioned client meets is a connection that
 * dies, which is what an offline device meets.
 */
export const PARTITION_PATH = "/__example__/network";
