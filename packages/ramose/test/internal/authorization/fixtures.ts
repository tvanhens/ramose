/**
 * Hand-written canonical JSON for structural decode / serialize tests.
 * Not compiler output. Semantic binding is out of scope.
 *
 * `RuleId` / `PolicyHash` are digest-shaped (64 lowercase hex). These
 * placeholders are structurally valid, not computed hashes.
 */

/** Repeat one byte as a 64-character lowercase hex digest. */
export const digestHex = (byte: number): string => byte.toString(16).padStart(2, "0").repeat(32);

export const RULE_OWNS_ISSUE = digestHex(0x11);
export const RULE_TENANT = digestHex(0x22);
export const RULE_HAS_TAG = digestHex(0x33);
export const POLICY_HASH_PLACEHOLDER = digestHex(0x44);
export const POLICY_HASH_OTHER = digestHex(0x45);
export const RULE_SAME = digestHex(0x55);
export const RULE_LIT = digestHex(0x66);
export const RULE_DEPTH = digestHex(0x77);

const issueOwner = { kind: "entity", name: "issue" } as const;
const taggableOwner = { kind: "trait", name: "taggable" } as const;
const userOwner = { kind: "entity", name: "user" } as const;

const v1Flags = {
  usesResource: false,
  usesMe: false,
  usesSubject: false,
  traversalDepth: 0,
} as const;

export const templateEncoded = {
  _tag: "PolicyTemplateIR",
  version: 2,
  languageVersion: "v1",
  classes: ["member"],
  claims: [
    {
      key: "org",
      optional: false,
      shape: { _tag: "scalar", valueType: "string" },
    },
    {
      key: "teams",
      optional: true,
      shape: { _tag: "array", items: { _tag: "scalar", valueType: "string" } },
    },
  ],
  principal: {
    subjectClaim: "sub",
    entity: { _tag: "RelativeFieldId", owner: userOwner, localName: "authId" },
  },
  rules: [
    {
      id: RULE_OWNS_ISSUE,
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
      expr: {
        _tag: "eq",
        left: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: { _tag: "RelativeFieldId", owner: issueOwner, localName: "owner" } }],
        },
        right: { _tag: "me" },
      },
      usesResource: true,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
    },
    {
      id: RULE_TENANT,
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
      expr: {
        _tag: "and",
        exprs: [
          { _tag: "hasClass", class: "member" },
          { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "claim", key: "org" } },
        ],
      },
      ...v1Flags,
      usesSubject: true,
    },
    {
      id: RULE_HAS_TAG,
      focus: { _tag: "trait", trait: { _tag: "RelativeTraitId", name: "taggable" } },
      expr: {
        _tag: "in",
        value: { _tag: "me" },
        collection: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: { _tag: "RelativeFieldId", owner: taggableOwner, localName: "tags" } }],
        },
      },
      usesResource: true,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
    },
  ],
  decisions: {
    operations: [],
    entities: [
      {
        target: { _tag: "RelativeEntityId", name: "issue" },
        decision: { allow: [RULE_OWNS_ISSUE, RULE_TENANT], deny: [] },
      },
    ],
    traits: [
      {
        target: { _tag: "RelativeTraitId", name: "taggable" },
        decision: { allow: [RULE_HAS_TAG], deny: [] },
      },
    ],
    fields: [],
  },
} as const;

export const installedEncoded = {
  _tag: "InstalledAuthorizationIR",
  version: 2,
  languageVersion: "v1",
  policyHash: POLICY_HASH_PLACEHOLDER,
  classes: ["member"],
  claims: [
    {
      key: "org",
      optional: false,
      shape: { _tag: "scalar", valueType: "string" },
    },
  ],
  principal: {
    subjectClaim: "sub",
    entity: { _tag: "FieldId", catalog: "app", owner: userOwner, localName: "authId" },
  },
  rules: [
    {
      id: RULE_OWNS_ISSUE,
      focus: { _tag: "entity", entity: { _tag: "EntityId", catalog: "app", name: "issue" } },
      expr: {
        _tag: "eq",
        left: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [
            {
              field: { _tag: "FieldId", catalog: "app", owner: issueOwner, localName: "owner" },
            },
          ],
        },
        right: { _tag: "me" },
      },
      usesResource: true,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
    },
  ],
  decisions: {
    operations: [],
    entities: [
      {
        target: { _tag: "EntityId", catalog: "app", name: "issue" },
        decision: { allow: [RULE_OWNS_ISSUE], deny: [] },
      },
    ],
    traits: [],
    fields: [],
  },
  accessPlans: [
    {
      rule: RULE_OWNS_ISSUE,
      lookups: [
        {
          _tag: "field",
          field: { _tag: "FieldId", catalog: "app", owner: issueOwner, localName: "owner" },
        },
      ],
    },
  ],
} as const;

const catalogUnitFieldOwner = {
  id: { _tag: "FieldId", catalog: "app", owner: issueOwner, localName: "owner" },
  valueType: "ref",
  refTarget: { _tag: "entity", entity: { _tag: "EntityId", catalog: "app", name: "user" } },
  cardinality: "one",
  index: false,
  optional: false,
  owned: false,
} as const;

const catalogUnitOperation = {
  id: {
    _tag: "OperationId",
    catalog: "app",
    owner: issueOwner,
    localName: "rename",
    target: "required",
  },
  input: {
    _tag: "struct",
    fields: [
      {
        key: "title",
        optional: false,
        shape: { _tag: "scalar", valueType: "string" },
      },
    ],
  },
  output: { _tag: "struct", fields: [] },
  inputSchemaHash: digestHex(0x91),
  outputSchemaHash: digestHex(0x92),
  bodyHash: digestHex(0x93),
  composers: [],
  writes: [],
} as const;

const catalogUnitComposition = [
  {
    composer: { _tag: "EntityId", catalog: "app", name: "issue" },
    trait: { _tag: "TraitId", catalog: "app", name: "taggable" },
    transitive: [{ _tag: "TraitId", catalog: "app", name: "taggable" }],
  },
] as const;

export const catalogUnitEncoded = {
  _tag: "InstalledCatalogUnit",
  version: 2,
  catalog: {
    id: "app",
    database: "todos",
    version: "1",
    fingerprint: "schema",
    entities: [
      {
        id: { _tag: "EntityId", catalog: "app", name: "issue" },
        traits: [{ _tag: "TraitId", catalog: "app", name: "taggable" }],
      },
    ],
    traits: [{ id: { _tag: "TraitId", catalog: "app", name: "taggable" }, traits: [] }],
    fields: [catalogUnitFieldOwner],
    operations: [catalogUnitOperation],
    traitComposition: catalogUnitComposition,
  },
  policy: installedEncoded,
  unitHash: digestHex(0x88),
} as const;

export const emptyTemplateEncoded = {
  _tag: "PolicyTemplateIR",
  version: 2,
  languageVersion: "v1",
  classes: [],
  claims: [],
  principal: { subjectClaim: "sub" },
  rules: [],
  decisions: { entities: [], traits: [], fields: [], operations: [] },
} as const;
