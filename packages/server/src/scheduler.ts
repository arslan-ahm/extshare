import type { Deps } from "./context";
import type { ReleaseService } from "./services/releases";

/**
 * Background maintenance: expire releases past their window, poll the Web Store for review
 * outcomes, and purge expired sessions/tokens. Runs are serialised so a slow sync never overlaps.
 */
export function startScheduler(deps: Deps, releases: ReleaseService, intervalMs: number): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const expired = releases.sweepExpired();
      const changed = await releases.syncAll();
      const purged = deps.store.purgeExpired(deps.now());
      if (expired || changed || purged) deps.log("info", "maintenance", { expired, changed, purged });
    } catch (e) {
      deps.log("error", "maintenance failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(handle);
}
