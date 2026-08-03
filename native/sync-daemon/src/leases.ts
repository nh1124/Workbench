/**
 * Tracks which desktop apps currently depend on this daemon.
 *
 * The daemon is one shared process that several apps use. It used to be owned by whichever
 * app spawned it, which meant that app killed it on exit and pulled it out from under the
 * others. Ownership now sits here: apps take a lease while they need the daemon and drop it
 * when they exit, and the daemon decides for itself whether anyone is left.
 *
 * Leases expire rather than relying on clients to clean up, because the case that matters is
 * the app that never got to say goodbye — a crash, a taskkill, a power loss. A stale entry
 * that outlives its holder by up to `LEASE_TTL_MS` is a far smaller problem than a counter
 * that never returns to zero.
 */

/** How long a lease survives without a heartbeat. */
export const LEASE_TTL_MS = 90_000;
/** How often clients are told to refresh. Comfortably inside the TTL so one lost beat is survivable. */
export const LEASE_HEARTBEAT_MS = 30_000;
/** How often expired leases are swept. */
export const LEASE_SWEEP_INTERVAL_MS = 10_000;
/**
 * How long the registry must stay empty before an idle shutdown is allowed.
 *
 * Restarting an app briefly drops its lease; without this the daemon would exit in that gap
 * and the app would come back to nothing.
 */
export const LEASE_IDLE_GRACE_MS = 60_000;

const MAX_CLIENT_ID_LENGTH = 200;

export type LeaseInput = {
  clientId: string;
  variant?: string;
  pid?: number;
};

export type LeaseRecord = {
  clientId: string;
  variant?: string;
  pid?: number;
  lastSeen: number;
};

export type LeaseListing = {
  items: Array<{ clientId: string; variant?: string; pid?: number; lastSeenIso: string }>;
  count: number;
};

export class LeaseValidationError extends Error {}

/** Normalizes and validates a client id, throwing {@link LeaseValidationError} when unusable. */
export function normalizeClientId(value: unknown): string {
  if (typeof value !== "string") {
    throw new LeaseValidationError("clientId must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LeaseValidationError("clientId must not be empty");
  }
  if (trimmed.length > MAX_CLIENT_ID_LENGTH) {
    throw new LeaseValidationError(`clientId must be at most ${MAX_CLIENT_ID_LENGTH} characters`);
  }
  return trimmed;
}

export class LeaseRegistry {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly now: () => number;
  private everHeldLease = false;
  /** When the registry last became empty, or null while it holds something. */
  private emptySince: number | null = null;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get count(): number {
    return this.leases.size;
  }

  /** True once any client has ever registered, which keeps a standalone daemon from exiting immediately. */
  get hasEverHeldLease(): boolean {
    return this.everHeldLease;
  }

  register(input: LeaseInput): { ttlMs: number; heartbeatMs: number; leaseCount: number } {
    const clientId = normalizeClientId(input.clientId);
    this.leases.set(clientId, {
      clientId,
      variant: input.variant,
      pid: input.pid,
      lastSeen: this.now()
    });
    this.everHeldLease = true;
    this.emptySince = null;
    return { ttlMs: LEASE_TTL_MS, heartbeatMs: LEASE_HEARTBEAT_MS, leaseCount: this.leases.size };
  }

  /**
   * Drops a lease. Releasing something unknown is deliberately not an error: a client whose
   * lease already expired must still be able to shut down cleanly.
   */
  release(clientId: string): { leaseCount: number } {
    this.leases.delete(normalizeClientId(clientId));
    this.markEmptyIfNeeded();
    return { leaseCount: this.leases.size };
  }

  /** Drops every lease past its TTL and returns how many went. */
  sweep(): number {
    const cutoff = this.now() - LEASE_TTL_MS;
    let removed = 0;
    for (const [clientId, record] of this.leases) {
      if (record.lastSeen <= cutoff) {
        this.leases.delete(clientId);
        removed += 1;
      }
    }
    this.markEmptyIfNeeded();
    return removed;
  }

  list(): LeaseListing {
    const items = [...this.leases.values()].map((record) => ({
      clientId: record.clientId,
      variant: record.variant,
      pid: record.pid,
      lastSeenIso: new Date(record.lastSeen).toISOString()
    }));
    return { items, count: items.length };
  }

  /**
   * Whether an idle shutdown is due.
   *
   * All three conditions matter: the feature must be on, something must have depended on the
   * daemon at some point (otherwise a daemon started by hand would exit before anything could
   * connect), and the registry must have been empty for the whole grace period.
   */
  shouldExitWhenIdle(exitWhenIdle: boolean): boolean {
    if (!exitWhenIdle) return false;
    if (!this.everHeldLease) return false;
    if (this.leases.size > 0) return false;
    if (this.emptySince === null) return false;
    return this.now() - this.emptySince >= LEASE_IDLE_GRACE_MS;
  }

  private markEmptyIfNeeded(): void {
    if (this.leases.size === 0 && this.emptySince === null) {
      this.emptySince = this.now();
    }
  }
}
