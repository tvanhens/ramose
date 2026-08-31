import * as Effect from "effect/Effect";
import * as EffectSchema from "effect/Schema";
import * as Result from "effect/Result";
import { Catalog, Policy } from "ramose";
import {
  bytes,
  Entity,
  EntityId,
  Field,
  Graph,
  OwnedOperations,
  Ref,
  Schema,
  Trait,
  string,
} from "ramose/db";
import {
  CatalogId,
  DigestHex,
  assembleCatalogDefinitions,
  hashReadCompatibility,
} from "../../packages/ramose/src/internal/authorization/index.ts";

export const GRAPH_PATH_ROOT_DATABASE = "graph-path-root";

let childCatalog!: ReturnType<typeof Catalog>;
let leafCatalog!: ReturnType<typeof Catalog>;

export const GateTagged = Trait("localGateTagged", {
  label: string({ optional: true }),
  tags: Field.many(string()),
}, {
  operations: (Operation) => ({
    retag: Operation({
      input: EffectSchema.Struct({ label: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId, label: EffectSchema.String }),
      run(op, input) {
        op.self.set(GateTagged.label, input.label);
        return { id: op.self, label: input.label };
      },
    }),
  }),
});

const GateLeft = Trait("localGateLeft", {}, { traits: [GateTagged] });
const GateRight = Trait("localGateRight", {}, { traits: [GateTagged] });
const GateDiamond = Trait("localGateDiamond", {}, {
  traits: [GateLeft, GateRight],
});

export const GateVisible = Entity("localGateVisible", {
  title: string(),
}, {
  traits: [GateDiamond],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        title: EffectSchema.String,
        label: EffectSchema.optionalKey(EffectSchema.String),
        tags: EffectSchema.optionalKey(EffectSchema.Array(EffectSchema.String)),
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return {
          id: op.create({
            title: input.title,
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.tags === undefined ? {} : { tags: input.tags }),
          }),
        };
      },
    }),
  }),
});

export const GateHidden = Entity("localGateHidden", {
  title: string(),
}, {
  traits: [GateDiamond],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        title: EffectSchema.String,
        label: EffectSchema.optionalKey(EffectSchema.String),
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return {
          id: op.create({
            title: input.title,
            ...(input.label === undefined ? {} : { label: input.label }),
          }),
        };
      },
    }),
  }),
});

export const GatePlain = Entity("localGatePlain", {
  title: string(),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ title: input.title }) };
      },
    }),
  }),
});

export const GateLink = Entity("localGateLink", {
  name: Field.unique(string(), "strict"),
  target: Ref(GateTagged, { optional: true }),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        name: EffectSchema.String,
        target: EffectSchema.optionalKey(EntityId),
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return {
          id: op.create({
            name: input.name,
            ...(input.target === undefined ? {} : { target: input.target as never }),
          }),
        };
      },
    }),
    deleteThenLink: Operation({
      self: false,
      writes: [GateVisible],
      input: EffectSchema.Struct({
        name: EffectSchema.String,
        target: EntityId,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.entity(GateVisible, input.target).delete();
        return { id: op.create({ name: input.name, target: input.target as never }) };
      },
    }),
  }),
});

export const Workspace = Entity("localWorkspace", {}, {
  traits: [Graph(() => childCatalog)],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ name: input.name }) };
      },
    }),
    rename: Operation({
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(Graph.name, input.name);
        return { id: op.self };
      },
    }),
    recatalog: Operation({
      input: EffectSchema.Struct({
        action: EffectSchema.Literals(["set", "remove"]),
      }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        if (input.action === "set") {
          (op.self as any).set(Graph.catalog, "caller-selected-catalog");
        } else {
          (op.self as any).remove(Graph.catalog);
        }
        return {};
      },
    }),
    remove: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run(op) {
        op.self.delete();
        return {};
      },
    }),
  }),
});

export const PrivateWorkspace = Entity("localPrivateWorkspace", {}, {
  traits: [Graph(() => childCatalog)],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ name: input.name }) };
      },
    }),
  }),
});

export const Project = Entity("localProject", {}, {
  traits: [Graph(() => leafCatalog)],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ name: input.name }) };
      },
    }),
  }),
});

export const NestedNote = Entity("localNestedNote", { text: string() }, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ text: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ text: input.text }) };
      },
    }),
  }),
});

export const BulkValue = Entity("localBulkValue", {
  label: Field.unique(string(), "strict"),
  body: string(),
  blob: bytes(),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        label: EffectSchema.String,
        body: EffectSchema.String,
        blob: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        const binary = atob(input.blob);
        const blob = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
          blob[index] = binary.charCodeAt(index);
        }
        return {
          id: op.create({ label: input.label, body: input.body, blob }),
        };
      },
    }),
  }),
});

export const GraphPathRootSchema = Schema({
  localWorkspace: Workspace,
  localPrivateWorkspace: PrivateWorkspace,
  localGateVisible: GateVisible,
  localGateHidden: GateHidden,
  localGatePlain: GatePlain,
  localGateLink: GateLink,
});
export const GraphPathChildSchema = Schema({ localProject: Project });
export const GraphPathLeafSchema = Schema({
  localNestedNote: NestedNote,
  localBulkValue: BulkValue,
});

const member = Policy.hasClass("member");
const rootReader = Policy.hasClass("root-reader");
const admin = Policy.hasClass("admin");
const rowOnly = Policy.hasClass("row-only");
const fieldOnly = Policy.hasClass("field-only");

leafCatalog = Catalog("local-graph-leaf", {
  schema: GraphPathLeafSchema,
  policy: await Effect.runPromise(Policy.compileReadAuthorization({
    schema: GraphPathLeafSchema,
    classes: ["member", "root-reader"],
    rules: [
      Policy.read(NestedNote).when(member),
      Policy.read(BulkValue).when(member),
      Policy.invoke(NestedNote[OwnedOperations].create).when(member),
      Policy.invoke(BulkValue[OwnedOperations].create).when(member),
    ],
  })),
});

childCatalog = Catalog("local-graph-child", {
  schema: GraphPathChildSchema,
  policy: await Effect.runPromise(Policy.compileReadAuthorization({
    schema: GraphPathChildSchema,
    classes: ["member", "root-reader"],
    rules: [
      Policy.read(Project).when(member),
      Policy.read(Graph).when(member),
      Policy.read(Graph.catalog).deny(member),
      Policy.invoke(Project[OwnedOperations].create).when(member),
    ],
  })),
});

export const graphPathCatalog = Catalog("local-graph-root", {
  schema: GraphPathRootSchema,
  policy: await Effect.runPromise(Policy.compileReadAuthorization({
    schema: GraphPathRootSchema,
    classes: ["member", "root-reader", "admin", "row-only", "field-only"],
    rules: [
      Policy.read(Workspace).when(Policy.any(member, rootReader)),
      Policy.read(PrivateWorkspace).when(admin),
      Policy.read(Graph).when(Policy.any(member, rootReader, admin)),
      Policy.read(Graph.catalog).deny(Policy.any(member, rootReader, admin)),
      Policy.invoke(Workspace[OwnedOperations].create).when(member),
      Policy.invoke(Workspace[OwnedOperations].rename).when(member),
      Policy.invoke(Workspace[OwnedOperations].recatalog).when(member),
      Policy.invoke(Workspace[OwnedOperations].remove).when(member),
      Policy.invoke(PrivateWorkspace[OwnedOperations].create).when(admin),
      Policy.read(GateVisible).when(Policy.any(member, rowOnly, fieldOnly)),
      Policy.read(GateHidden).when(admin),
      Policy.read(GatePlain).when(member),
      Policy.read(GateLink).when(Policy.any(member, rowOnly, fieldOnly)),
      Policy.read(GateTagged).when(Policy.any(member, admin, fieldOnly)),
      Policy.read(GateTagged.label).when(Policy.any(member, admin)),
      Policy.read(GateTagged.label).deny(fieldOnly),
      Policy.invoke(GateVisible[OwnedOperations].create).when(member),
      Policy.invoke(GateHidden[OwnedOperations].create).when(admin),
      Policy.invoke(GatePlain[OwnedOperations].create).when(member),
      Policy.invoke(GateLink[OwnedOperations].create).when(member),
      Policy.invoke(GateLink[OwnedOperations].deleteThenLink).when(member),
      Policy.invoke(GateTagged[OwnedOperations].retag).when(member),
    ],
  })),
});

export const graphPathCatalogDeployment = Object.freeze({
  root: graphPathCatalog,
  deployments: [{ database: GRAPH_PATH_ROOT_DATABASE }],
});

const compatibilityDefinitions = await Effect.runPromise(assembleCatalogDefinitions({
  root: graphPathCatalog,
  artifactHash: DigestHex.make("0".repeat(64)),
}));
const compatibilityUnit = (id: string) =>
  Result.getOrThrow(compatibilityDefinitions.require(CatalogId.make(id)));

export const graphPathLeafReadCompatibilityHash = await Effect.runPromise(
  hashReadCompatibility(compatibilityUnit("local-graph-leaf").unit.catalog),
);

/** The catalog a `Workspace` Graph binds its child database to. */
export const graphPathChildReadCompatibilityHash = await Effect.runPromise(
  hashReadCompatibility(compatibilityUnit("local-graph-child").unit.catalog),
);

/**
 * The *root* catalog's read-compatibility hash.
 *
 * What a client that installed the root catalog would send for any path. A
 * Graph child binds a different catalog, so activating one with this hash is
 * exactly the "client installed the wrong catalog for this database" case, and
 * the server has to refuse it before any data-bearing frame.
 */
export const graphPathRootReadCompatibilityHash = await Effect.runPromise(
  hashReadCompatibility(compatibilityUnit("local-graph-root").unit.catalog),
);
