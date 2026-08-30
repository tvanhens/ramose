/**
 * The versioned public MCP wire contract (#485).
 *
 * This module is the single owner of the shape of everything Ramose's MCP
 * surface puts on the wire: the three kernel tool schemas, the result and
 * error unions, public references, operation versions and cards, opaque
 * handles, pagination, receipts, canonical serialization, the derived text
 * representation, and the rules for changing any of it.
 *
 * It deliberately depends on no MCP SDK and no transport. The projection
 * (#488) fills these shapes from an authorization-filtered catalog; the
 * modern Streamable HTTP handler (#489) carries them. Both are separate
 * issues, and neither may add a shape of its own.
 *
 * The module is internal until #489 wires it up: it is not re-exported from
 * any published entry point, so nothing here is a public npm API yet.
 *
 * ## Where the boundaries are
 *
 * - The **query document** and its expression language belong to #486/#507.
 *   `query-document.ts` defines only the versioned envelope and names the
 *   integration seam.
 * - The **operation-scoped version** and the **durable receipt** belong to
 *   #487/#527. `references.ts` and `receipts.ts` project those primitives;
 *   they do not re-derive them.
 * - **Live delivery** (#541), **Tasks** (#543), and **generated aliases**
 *   (#542) are measured extensions. Each has a named, additive extension
 *   point here and no implementation.
 */

export * from "./bounds.ts";
export * from "./cards.ts";
export * from "./compatibility.ts";
export * from "./errors.ts";
export * from "./json-schema.ts";
export * from "./primitives.ts";
export * from "./query-document.ts";
export * from "./receipts.ts";
export * from "./references.ts";
export * from "./serialization.ts";
export * from "./text.ts";
export * from "./tools.ts";
