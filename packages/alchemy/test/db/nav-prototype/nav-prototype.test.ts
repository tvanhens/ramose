import { describe, expect, test } from "bun:test";
import { Comment, IfaceTodo, Todo, User } from "./fixture.ts";

describe("nav-prototype runtime paths", () => {
  test("Todo.owner.friends.name (gate)", () => {
    expect(Todo.owner.friends.name.ident).toBe(":user/name");
    expect(Todo.owner.friends.name.attrName).toBe("name");
  });

  test("self-ref and cross-ns hops", () => {
    expect(User.friends.friends.name.ident).toBe(":user/name");
    expect(Comment.author.friends.name.ident).toBe(":user/name");
    expect(Comment.replyTo.body.ident).toBe(":comment/body");
  });

  test("interface-deferred encoding", () => {
    expect(IfaceTodo.owner.friends.name.ident).toBe(":user/name");
    expect(IfaceTodo.owner.friends.friends.friends.name.ident).toBe(
      ":user/name",
    );
  });
});
