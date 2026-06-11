import { setupServer } from 'msw/node';
import { handlers } from './__mocks__/lifi-api.ts';

// MSW server intercepts fetch calls during tests. This is a legitimate
// external-service mock — CLAUDE.md's "no mocks in the hot path" rule applies
// to production code paths; Li.Fi is an external HTTP API with rate limits.
export const server = setupServer(...handlers);
