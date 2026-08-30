export const ISS = "https://auth.acme.test";
export const AUD = "ramose:peer:test";
export const SHARED_TOKEN = "s3cret";

export const PUBLIC_JWK = {
  crv: "P-256",
  kty: "EC",
  x: "hUkk11Woi4F2fQrScAGDMSFolDcb_urvdvYyoQBct_g",
  y: "yoxcOGNxbe6kW0CLfOmXUCEJhzfqGEyA-WCCTtqIGsI",
  alg: "ES256",
  kid: "test",
} as const;

export const JWKS = JSON.stringify({ keys: [PUBLIC_JWK] });

const allow = (expr: unknown) => [{ _tag: "allow", expr }];
const eq = (attr: string, operand?: unknown) => ({
  _tag: "eq",
  attr,
  operand: operand ?? { _tag: "principal" },
});
const ref = (attr: string, target: unknown) => ({ _tag: "ref", attr, target });
const inOrg = ref(":doc/project", ref(":project/org", eq(":org/members")));

export const POLICY = {
  version: 1,
  principal: ":user/sub",
  classes: ["anonymous", "member", "admin"],
  superuser: "admin",
  ns: {
    doc: {
      read: allow({ _tag: "or", exprs: [eq(":doc/owner"), inOrg] }),
    },
    project: { read: allow(ref(":project/org", eq(":org/members"))) },
    org: { read: allow(eq(":org/members")) },
    user: { read: allow(eq(":user/sub", { _tag: "claim", path: ["sub"] })) },
    movie: { read: allow({ _tag: "class", class: "member" }) },
  },
  attrs: { ":doc/audit": { read: allow({ _tag: "class", class: "admin" }) } },
  operations: Object.fromEntries(
    [
      "e2e/add-session",
      "e2e/add-reef-user",
      "e2e/add-reef-issue",
      "e2e/move-reef-issue",
      "movie/set-title",
      "ping",
      "todo/add",
      "todo/set-done",
      "todo/delete",
      "user/create",
      "user/create-coded",
      "user/create-put",
      "user/create-short",
      "user/put-bootstrap",
      "user/put-dangling-ref",
      "user/put-missing-eid",
      "user/put-on-movie",
      "user/set-name",
      "user/update-ghost",
    ].map((name) => [name, allow({ _tag: "class", class: "member" })]),
  ),
};

export const POLICY_JSON = JSON.stringify(POLICY);

export const POLICY_CLOSED_JSON = JSON.stringify({
  ...POLICY,
  classes: ["member", "admin"],
});

export const POLICY_SCHEMA_JSON = JSON.stringify({
  ...POLICY,
  schemaClasses: ["member"],
});
