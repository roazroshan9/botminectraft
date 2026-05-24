import { logger } from "../lib/logger.js";

export function startMemoryMonitor(intervalMs = 60000) {
  const interval = setInterval(() => {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);

    logger.info({ heapUsedMB, heapTotalMB, rssMB }, "Memory usage");

    if (heapUsedMB > 400) {
      logger.warn({ heapUsedMB }, "High memory usage, triggering GC hint");
      if (global.gc) global.gc();
    }
  }, intervalMs);

  interval.unref();
  return interval;
}

export function getMemoryStats() {
  const mem = process.memoryUsage();
  return {
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    rssMB: Math.round(mem.rss / 1024 / 1024),
    externalMB: Math.round(mem.external / 1024 / 1024),
  };
}
