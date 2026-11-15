// Shared, finite startup budget. Repeated observations of one identity cannot renew it.
export const STARTUP_TIMEOUT_MS = 60000;

export function createStartupDeadline({ waitMs = STARTUP_TIMEOUT_MS, now = () => Date.now() } = {}) {
  let identity;
  let since;
  return {
    observe(key) {
      if (since === undefined || key !== identity) { identity = key; since = now(); }
    },
    reset() { identity = undefined; since = undefined; },
    expired() { return since !== undefined && now() - since >= waitMs; },
  };
}
