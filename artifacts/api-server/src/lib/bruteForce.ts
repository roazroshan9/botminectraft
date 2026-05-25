const store = new Map<string, { count: number; lockedUntil: number }>();

const LIMITS = {
  user:  { max: 5, windowMs: 15 * 60 * 1000 },
  admin: { max: 5, windowMs: 30 * 60 * 1000 },
};

function key(ip: string, type: "user" | "admin") {
  return `${type}:${ip}`;
}

export function checkLock(ip: string, type: "user" | "admin"): { locked: boolean; retryAfterSec?: number; remaining?: number } {
  const entry = store.get(key(ip, type));
  if (!entry) return { locked: false, remaining: LIMITS[type].max };

  if (entry.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSec: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
  }

  const remaining = Math.max(0, LIMITS[type].max - entry.count);
  return { locked: false, remaining };
}

export function recordFailure(ip: string, type: "user" | "admin"): { locked: boolean; retryAfterSec?: number; remaining: number } {
  const { max, windowMs } = LIMITS[type];
  const k = key(ip, type);
  const entry = store.get(k) ?? { count: 0, lockedUntil: 0 };

  if (entry.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSec: Math.ceil((entry.lockedUntil - Date.now()) / 1000), remaining: 0 };
  }

  entry.count += 1;
  if (entry.count >= max) entry.lockedUntil = Date.now() + windowMs;
  store.set(k, entry);

  return {
    locked: entry.count >= max,
    retryAfterSec: entry.lockedUntil > 0 ? Math.ceil((entry.lockedUntil - Date.now()) / 1000) : undefined,
    remaining: Math.max(0, max - entry.count),
  };
}

export function clearAttempts(ip: string, type: "user" | "admin") {
  store.delete(key(ip, type));
}

export function getClientIp(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (first ?? req.ip ?? "unknown").trim();
}
