/**
 * Hand-written canonical JSON for structural decode / serialize tests.
 * Not compiler output. Semantic binding is out of scope.
 */

const issueOwner = { kind: "entity", name: "issue" } as const;
const taggableOwner = { kind: "trait", name: "taggable" } as const;
const userOwner = { kind: "entity", name: "user" } as const;
const grantOwner = { kind: "entity", name: "tag-grant" } as const;

export const templateEncoded = {
  _tag: "PolicyTemplateIR",
  version: 1,
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
    entity: { _tag: "RelativeFieldId", owner: userOwner, localName: "authId" },
  },
  rules: [
    {
      id: "owns-issue",
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
      usesInput: false,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
      existsDepth: 0,
      dependencies: [],
    },
    {
      id: "rename-input",
      focus: {
        _tag: "operation",
        operation: {
          _tag: "RelativeOperationId",
          owner: issueOwner,
          localName: "rename",
          target: "required",
        },
      },
      expr: {
        _tag: "and",
        exprs: [
          { _tag: "hasClass", class: "member" },
          { _tag: "has", term: { _tag: "input", path: ["title"] } },
          { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "claim", key: "org" } },
        ],
      },
      usesResource: false,
      usesInput: true,
      usesMe: false,
      usesSubject: true,
      traversalDepth: 0,
      existsDepth: 0,
      dependencies: [],
    },
    {
      id: "tag-grant",
      focus: { _tag: "trait", trait: { _tag: "RelativeTraitId", name: "taggable" } },
      expr: {
        _tag: "some",
        collection: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: { _tag: "RelativeFieldId", owner: taggableOwner, localName: "tags" } }],
        },
        bind: "tag",
        pred: {
          _tag: "exists",
          entity: { _tag: "RelativeEntityId", name: "tag-grant" },
          bind: "grant",
          pred: {
            _tag: "and",
            exprs: [
              {
                _tag: "eq",
                left: {
                  _tag: "ref",
                  root: { _tag: "bind", name: "grant" },
                  steps: [
                    { field: { _tag: "RelativeFieldId", owner: grantOwner, localName: "user" } },
                  ],
                },
                right: { _tag: "me" },
              },
              {
                _tag: "eq",
                left: {
                  _tag: "ref",
                  root: { _tag: "bind", name: "grant" },
                  steps: [
                    { field: { _tag: "RelativeFieldId", owner: grantOwner, localName: "tag" } },
                  ],
                },
                right: { _tag: "bind", name: "tag" },
              },
            ],
          },
        },
      },
      usesResource: true,
      usesInput: false,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
      existsDepth: 1,
      dependencies: [],
    },
  ],
  decisions: {
    entities: [
      {
        target: { _tag: "RelativeEntityId", name: "issue" },
        decision: { allow: ["owns-issue"], deny: [] },
      },
    ],
    traits: [
      {
        target: { _tag: "RelativeTraitId", name: "taggable" },
        decision: { allow: ["tag-grant"], deny: [] },
      },
    ],
    fields: [],
    operations: [
      {
        target: {
          _tag: "RelativeOperationId",
          owner: issueOwner,
          localName: "rename",
          target: "required",
        },
        decision: { allow: ["rename-input"], deny: [] },
      },
      {
        target: {
          _tag: "RelativeOperationId",
          owner: issueOwner,
          localName: "create",
          target: "none",
        },
        decision: { allow: ["rename-input"], deny: [] },
      },
    ],
  },
} as const;

export const installedEncoded = {
  _tag: "InstalledAuthorizationIR",
  version: 1,
  database: "todos",
  catalog: "app",
  catalogVersion: "1",
  schemaFingerprint: "schema",
  policyHash: "policy",
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
  identities: {
    entities: [{ _tag: "EntityId", catalog: "app", name: "issue" }],
    traits: [{ _tag: "TraitId", catalog: "app", name: "taggable" }],
    fields: [{ _tag: "FieldId", catalog: "app", owner: issueOwner, localName: "owner" }],
    operations: [
      {
        _tag: "OperationId",
        catalog: "app",
        owner: issueOwner,
        localName: "rename",
        target: "required",
      },
      {
        _tag: "OperationId",
        catalog: "app",
        owner: issueOwner,
        localName: "create",
        target: "none",
      },
    ],
  },
  traitComposition: [
    {
      composer: { _tag: "EntityId", catalog: "app", name: "issue" },
      trait: { _tag: "TraitId", catalog: "app", name: "taggable" },
      transitive: [{ _tag: "TraitId", catalog: "app", name: "taggable" }],
    },
  ],
  operations: [
    {
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
    },
  ],
  rules: [
    {
      id: "owns-issue",
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
      usesInput: false,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
      existsDepth: 0,
      dependencies: [],
    },
  ],
  decisions: {
    entities: [
      {
        target: { _tag: "EntityId", catalog: "app", name: "issue" },
        decision: { allow: ["owns-issue"], deny: [] },
      },
    ],
    traits: [],
    fields: [],
    operations: [],
  },
  accessPlans: [
    {
      rule: "owns-issue",
      lookups: [
        {
          _tag: "field",
          field: { _tag: "FieldId", catalog: "app", owner: issueOwner, localName: "owner" },
        },
      ],
    },
  ],
} as const;

export const emptyTemplateEncoded = {
  _tag: "PolicyTemplateIR",
  version: 1,
  classes: [],
  claims: [],
  principal: { subjectClaim: "sub" },
  rules: [],
  decisions: { entities: [], traits: [], fields: [], operations: [] },
} as const;
