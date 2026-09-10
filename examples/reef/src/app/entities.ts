import type { EntityHandleFor } from "ramose/client";
import { Issue, Person } from "../domain/schema.ts";

export type IssueRow = EntityHandleFor<typeof Issue>;
export type PersonRow = EntityHandleFor<typeof Person>;

export type Member = {
  readonly sub: string;
  readonly label: string;
};

export const personLabel = (person: PersonRow | undefined): string =>
  person?.data.name ?? person?.data.email ?? "Someone";
