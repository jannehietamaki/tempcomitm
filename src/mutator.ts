/**
 * Response mutator for the Tempco/Purmo MITM proxy.
 *
 * Optionally injects local device state into upstream API responses,
 * allowing local consumers to access real-time device data without
 * additional queries.
 */

import { StateManager } from './state.js';

/**
 * Create a response mutator function that enriches upstream responses
 * with local device state.
 *
 * The returned function inspects the request path and response body.
 * For `/machine/query/check/` responses it injects a
 * `"local_state_snapshot"` key containing all known device states.
 *
 * @param state - The StateManager instance to read device data from.
 * @returns A mutator function `(path, body) => mutatedBody | null`.
 *          Returns `null` when no mutation is needed or on parse errors.
 */
export function createResponseMutator(
  state: StateManager,
): (path: string, body: string) => string | null {
  return (path: string, body: string): string | null => {
    // Only mutate responses to the machine query check endpoint
    if (!path.includes('/machine/query/check/')) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }

      const enriched = parsed as Record<string, unknown>;
      enriched['local_state_snapshot'] = state.getAllDevices();
      return JSON.stringify(enriched);
    } catch {
      // JSON parse failure -- leave the response untouched
      return null;
    }
  };
}
