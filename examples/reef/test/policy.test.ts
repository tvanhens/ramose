import { describe, expect, test } from "bun:test";
import { OwnedOperations } from "ramose/db";
import {
  Comment,
  Issue,
  Label,
  Person,
  ROOT_DATABASE,
  Reef,
  Workspace,
  deployment,
} from "../src/domain/schema.ts";
import { isWorkspaceSlug, slugify } from "../src/domain/shared.ts";

describe("the reef deployment", () => {
  test("applies its policy and configures the root database", () => {
    expect(deployment.root).toBe(Reef);
    expect(deployment.deployments).toEqual([{ database: ROOT_DATABASE }]);
  });

  test("declares every entity and its operations", () => {
    expect(Object.keys(Reef.entities).sort()).toEqual([
      "comment",
      "issue",
      "label",
      "person",
      "workspace",
    ]);
    expect(Object.keys(Workspace[OwnedOperations]).sort()).toEqual([
      "addMember",
      "createWorkspace",
      "ensureMe",
      "removeMember",
      "renameWorkspace",
    ]);
    expect(Object.keys(Issue[OwnedOperations]).sort()).toEqual([
      "addLabel",
      "createIssue",
      "deleteIssue",
      "editIssue",
      "moveIssue",
      "removeLabel",
      "setAssignee",
      "setPriority",
      "setPrivateNote",
    ]);
    expect(Object.keys(Comment[OwnedOperations]).sort()).toEqual([
      "createComment",
      "deleteComment",
    ]);
    expect(Object.keys(Label[OwnedOperations])).toEqual(["createLabel"]);
    expect(Object.keys(Person[OwnedOperations as keyof typeof Person] ?? {})).toEqual([]);
  });
});

describe("workspace slugs", () => {
  test("accepts ordinary slugs and rejects reserved or invalid ones", () => {
    expect(isWorkspaceSlug("acme")).toBe(true);
    expect(isWorkspaceSlug("my-team-2")).toBe(true);
    expect(isWorkspaceSlug("api")).toBe(false);
    expect(isWorkspaceSlug("db")).toBe(false);
    expect(isWorkspaceSlug("reef")).toBe(false);
    expect(isWorkspaceSlug("A Team")).toBe(false);
    expect(isWorkspaceSlug("")).toBe(false);
    expect(isWorkspaceSlug("-leading")).toBe(false);
  });

  test("slugify produces valid slugs from display names", () => {
    expect(isWorkspaceSlug(slugify("Acme Corp"))).toBe(true);
    expect(slugify("Acme Corp")).toBe("acme-corp");
    expect(slugify("  Rocket 🚀 Team  ")).toBe("rocket-team");
  });
});
