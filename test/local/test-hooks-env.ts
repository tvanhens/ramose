/** Enables `/__test__/*` on the local integration peers. Never set in prod. */
export const TEST_HOOKS_ENV = { RAMOSE_TEST_HOOKS: "1" } as const;
