import * as Ramose from "ramose";
import { TEST_HOOKS_ENV } from "./test-hooks-env.ts";

export const Open = Ramose.Server("Open", {
  peer: "OpenPeer",
  storage: "OpenStore",
  main: import.meta.resolve("./worker.ts"),
  env: TEST_HOOKS_ENV,
});
