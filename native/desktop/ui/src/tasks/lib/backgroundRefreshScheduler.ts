export interface BackgroundRefreshScheduler {
  schedule: () => void;
  cancel: () => void;
}

interface BackgroundRefreshSchedulerOptions {
  refresh: () => Promise<void>;
  isBlocked?: () => boolean;
  delayMs?: number;
}

/**
 * Create a trailing background-refresh scheduler.
 *
 * All callers share one timer. A blocked refresh is deferred, and a timer that
 * expires while a refresh is running records one (and only one) follow-up.
 */
export function createBackgroundRefreshScheduler({
  refresh,
  isBlocked = () => false,
  delayMs = 800,
}: BackgroundRefreshSchedulerOptions): BackgroundRefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight = false;
  let followUpQueued = false;
  let cancelled = false;

  const armTimer = () => {
    if (cancelled) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(onTimer, delayMs);
  };

  const startRefresh = () => {
    refreshInFlight = true;
    void refresh()
      .catch(() => {
        // Background refresh failures are surfaced by the loader itself.
      })
      .finally(() => {
        refreshInFlight = false;
        if (cancelled || !followUpQueued) return;
        followUpQueued = false;
        if (isBlocked()) {
          armTimer();
        } else {
          startRefresh();
        }
      });
  };

  function onTimer() {
    timer = undefined;
    if (cancelled) return;
    if (isBlocked()) {
      armTimer();
      return;
    }
    if (refreshInFlight) {
      followUpQueued = true;
      return;
    }
    startRefresh();
  }

  return {
    schedule: armTimer,
    cancel: () => {
      cancelled = true;
      followUpQueued = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
