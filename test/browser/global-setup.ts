import { startExampleStack, type ExampleStack } from "./stack.ts";

let stack: ExampleStack | undefined;

export const setup = async (): Promise<void> => {
  stack ??= await startExampleStack(new URL("../..", import.meta.url).pathname);
};

export const teardown = async (): Promise<void> => {
  await stack?.stop();
  stack = undefined;
};
