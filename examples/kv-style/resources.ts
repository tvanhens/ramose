import * as Ramose from "ramose";

export const Server = Ramose.Server("Ramose", {
  main: import.meta.resolve("./peer.ts"),
});
