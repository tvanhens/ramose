const PEER_ENTRY = "ramose/worker";

export const workerEntry = (): string => {
  try {
    return import.meta.resolve(PEER_ENTRY);
  } catch (cause) {
    throw new Error(
      `ramose: cannot resolve ${PEER_ENTRY} — the deploy script cannot see its own package. Install \`ramose\` in the project the stack file belongs to, or point \`main\` at your own module that re-exports it.`,
      { cause },
    );
  }
};
