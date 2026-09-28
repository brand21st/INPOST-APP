export type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};
