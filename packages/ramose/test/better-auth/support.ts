/** The memory adapter wants its tables pre-created. */
export const memoryDb = () => ({
  user: [],
  session: [],
  account: [],
  verification: [],
  organization: [],
  member: [],
  invitation: [],
  jwks: [],
});
