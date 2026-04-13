/**
 * Proxy Rotation Scheduler
 * 
 * Orchestrates automated proxy rotation:
 * 1. Fetches fresh nodes periodically
 * 2. Health checks existing pools
 * 3. Assigns unique IPs to connections
 * 4. Cleans up dead pools
 * 
 * Started automatically in initializeApp.js when settings.enableProxyRotation = true
 */

import { getProxyPools, deleteProxyPool, getProviderConnections, getSettings, updateSettings } from "../models/index.js";
import { initRotationManager, assignUniqueIPs, forceRotate, shouldRotate, getRotationState, updateRotationConfig } from "./proxyRotation.js";
import { checkAllProxies, startAutomatedHealthCheck, stopAutomatedHealthCheck, getHealthCheckStatus } from "./proxyHealth.js";
import { fetchFreshProxies } from "./proxyFetcher.js";

const log = (level, ...args) => {
  console.log(`[RotationScheduler][${level.toUpperCase()}]`, ...args);
};

let schedulerState = {
  running: false,
  started: false,
  intervals: {
    healthCheckMs: 300000,      // 5 min
    fetchNewNodesMs: 3600000,   // 1 hour
    rotateIPsMs: 3600000,       // 1 hour
    cleanupDeadPoolsMs: 7200000 // 2 hours
  },
  timers: {},
  lastRun: {
    healthCheck: null,
    fetchNodes: null,
    rotateIPs: null,
    cleanup: null
  }
};

/**
 * Default rotation settings
 */
const DEFAULT_SETTINGS = {
  enableProxyRotation: false,
  proxyRotationStrategy: "sticky",       // "sticky" | "round-robin" | "dedicated"
  proxyRotationIntervalMs: 3600000,       // 1 hour
  proxyHealthCheckIntervalMs: 300000,     // 5 min
  proxyFetchIntervalMs: 3600000,          // 1 hour
  proxyMinHealthyCount: 2,
  proxyMaxFailures: 3,
  proxyAutoFetchEnabled: true,
  proxyAutoFetchIntervalMs: 3600000       // 1 hour
};

/**
 * Initialize and start the proxy rotation scheduler
 * Called from initializeApp.js on startup
 */
export async function startProxyRotationScheduler() {
  if (schedulerState.started) {
    log("warn", "Scheduler already started");
    return;
  }

  log("info", "Initializing proxy rotation scheduler...");

  // Load settings
  const settings = await getSettings();
  const rotationEnabled = settings.enableProxyRotation ?? DEFAULT_SETTINGS.enableProxyRotation;

  if (!rotationEnabled) {
    log("info", "Proxy rotation disabled in settings");
    return;
  }

  // Initialize rotation manager
  initRotationManager({
    enabled: true,
    strategy: settings.proxyRotationStrategy ?? DEFAULT_SETTINGS.proxyRotationStrategy,
    rotationIntervalMs: settings.proxyRotationIntervalMs ?? DEFAULT_SETTINGS.proxyRotationIntervalMs,
    minHealthyProxies: settings.proxyMinHealthyCount ?? DEFAULT_SETTINGS.proxyMinHealthyCount,
    maxFailures: settings.proxyMaxFailures ?? DEFAULT_SETTINGS.proxyMaxFailures,
    logLevel: "info"
  });

  // Update internal intervals
  schedulerState.intervals = {
    healthCheckMs: settings.proxyHealthCheckIntervalMs ?? DEFAULT_SETTINGS.proxyHealthCheckIntervalMs,
    fetchNewNodesMs: settings.proxyFetchIntervalMs ?? DEFAULT_SETTINGS.proxyFetchIntervalMs,
    rotateIPsMs: settings.proxyRotationIntervalMs ?? DEFAULT_SETTINGS.proxyRotationIntervalMs,
    cleanupDeadPoolsMs: DEFAULT_SETTINGS.cleanupDeadPoolsMs
  };

  schedulerState.started = true;

  // Run initial cycle
  log("info", "Running initial rotation cycle...");
  await runFullCycle();

  // Start periodic tasks
  startPeriodicTasks();

  log("info", "Scheduler started with intervals:", schedulerState.intervals);
}

/**
 * Stop the proxy rotation scheduler
 */
export function stopProxyRotationScheduler() {
  if (!schedulerState.started) return;

  log("info", "Stopping proxy rotation scheduler...");

  // Clear all timers
  for (const [name, timerId] of Object.entries(schedulerState.timers)) {
    if (timerId) {
      clearInterval(timerId);
      log("debug", `Cleared ${name} timer`);
    }
  }

  schedulerState.timers = {};
  schedulerState.started = false;
  stopAutomatedHealthCheck();

  log("info", "Scheduler stopped");
}

/**
 * Run a full rotation cycle:
 * 1. Health check all pools
 * 2. Fetch new nodes if needed
 * 3. Assign unique IPs
 * 4. Clean up dead pools
 */
export async function runFullCycle() {
  if (schedulerState.running) {
    log("warn", "Cycle already running, skipping");
    return;
  }

  schedulerState.running = true;
  log("info", "=== Starting full rotation cycle ===");

  try {
    // Step 1: Health check
    log("info", "[1/4] Health checking all pools...");
    const healthResults = await checkAllProxies({ testAll: false });
    schedulerState.lastRun.healthCheck = new Date().toISOString();

    const healthyCount = healthResults.filter(r => r.status === "active").length;
    const deadCount = healthResults.filter(r => r.status === "error").length;
    log("info", `  Health: ${healthyCount} healthy, ${deadCount} dead`);

    // Step 2: Fetch new nodes if not enough healthy pools
    const connections = await getProviderConnections();
    const activeConnections = connections.filter(c => c.isActive).length;
    const settings = await getSettings();

    if (healthyCount < activeConnections && (settings.proxyAutoFetchEnabled ?? DEFAULT_SETTINGS.proxyAutoFetchEnabled)) {
      log("info", `[2/4] Not enough healthy pools (${healthyCount} < ${activeConnections}), fetching new nodes...`);
      const fetchResults = await fetchFreshProxies({ testNodes: true });
      schedulerState.lastRun.fetchNodes = new Date().toISOString();
      log("info", `  Fetched: ${fetchResults.fetched} URLs, ${fetchResults.added} new pools added`);
    } else {
      log("info", `[2/4] Enough healthy pools (${healthyCount} >= ${activeConnections}), skipping fetch`);
    }

    // Step 3: Assign unique IPs to connections
    log("info", "[3/4] Assigning unique IPs to connections...");
    const assignmentResult = await assignUniqueIPs();
    schedulerState.lastRun.rotateIPs = new Date().toISOString();
    log("info", `  Assigned: ${assignmentResult.assigned} connections, ${assignmentResult.uniqueIPs} unique IPs`);

    // Step 4: Clean up dead pools
    log("info", "[4/4] Cleaning up dead pools...");
    const cleanupResult = await cleanupDeadPools();
    schedulerState.lastRun.cleanup = new Date().toISOString();
    log("info", `  Cleanup: ${cleanupResult.removed} dead pools removed`);

    log("info", "=== Rotation cycle complete ===");
  } catch (err) {
    log("error", `Cycle failed: ${err.message}`, err.stack);
  } finally {
    schedulerState.running = false;
  }
}

/**
 * Start periodic timers for automated rotation
 */
function startPeriodicTasks() {
  // Health check timer
  schedulerState.timers.healthCheck = setInterval(async () => {
    try {
      log("info", "[Scheduled] Health check...");
      await checkAllProxies({ testAll: false });
      schedulerState.lastRun.healthCheck = new Date().toISOString();
    } catch (err) {
      log("error", `Scheduled health check failed: ${err.message}`);
    }
  }, schedulerState.intervals.healthCheckMs);

  // Fetch new nodes timer
  if (schedulerState.intervals.fetchNewNodesMs > 0) {
    schedulerState.timers.fetchNodes = setInterval(async () => {
      try {
        log("info", "[Scheduled] Fetching new nodes...");
        const settings = await getSettings();
        if (settings.proxyAutoFetchEnabled ?? DEFAULT_SETTINGS.proxyAutoFetchEnabled) {
          await fetchFreshProxies({ testNodes: true });
          schedulerState.lastRun.fetchNodes = new Date().toISOString();
        }
      } catch (err) {
        log("error", `Scheduled fetch failed: ${err.message}`);
      }
    }, schedulerState.intervals.fetchNewNodesMs);
  }

  // IP rotation timer
  schedulerState.timers.rotateIPs = setInterval(async () => {
    try {
      if (shouldRotate()) {
        log("info", "[Scheduled] Rotating IPs...");
        await forceRotate();
        schedulerState.lastRun.rotateIPs = new Date().toISOString();
      }
    } catch (err) {
      log("error", `Scheduled rotation failed: ${err.message}`);
    }
  }, schedulerState.intervals.rotateIPsMs);

  // Cleanup timer
  schedulerState.timers.cleanup = setInterval(async () => {
    try {
      log("info", "[Scheduled] Cleaning up dead pools...");
      await cleanupDeadPools();
      schedulerState.lastRun.cleanup = new Date().toISOString();
    } catch (err) {
      log("error", `Scheduled cleanup failed: ${err.message}`);
    }
  }, schedulerState.intervals.cleanupDeadPoolsMs);
}

/**
 * Remove dead proxy pools (inactive, failed tests, not bound to any connection)
 */
async function cleanupDeadPools() {
  const pools = await getProxyPools();
  const connections = await getProviderConnections();
  
  // Find pools bound to connections
  const boundPoolIds = new Set();
  for (const conn of connections) {
    if (conn.providerSpecificData?.proxyPoolId) {
      boundPoolIds.add(conn.providerSpecificData.proxyPoolId);
    }
  }

  const deadPools = pools.filter(p => 
    p.isActive === false || 
    p.testStatus === "error"
  );

  let removed = 0;
  for (const pool of deadPools) {
    // Don't remove pools that are still bound to connections
    if (boundPoolIds.has(pool.id)) continue;
    
    // Don't remove Vercel-type pools (they're manually deployed)
    if (pool.type === "vercel") continue;

    try {
      await deleteProxyPool(pool.id);
      removed++;
      log("debug", `  Removed dead pool: ${pool.name}`);
    } catch (err) {
      log("error", `Failed to remove pool ${pool.id}: ${err.message}`);
    }
  }

  return { removed, totalDead: deadPools.length };
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus() {
  return {
    running: schedulerState.running,
    started: schedulerState.started,
    intervals: schedulerState.intervals,
    lastRun: schedulerState.lastRun,
    healthCheck: getHealthCheckStatus(),
    rotation: getRotationState()
  };
}

/**
 * Trigger a manual full cycle (from API or UI)
 */
export async function triggerManualCycle() {
  log("info", "Manual rotation cycle triggered");
  await runFullCycle();
  return getSchedulerStatus();
}

export default {
  startProxyRotationScheduler,
  stopProxyRotationScheduler,
  runFullCycle,
  triggerManualCycle,
  getSchedulerStatus,
  DEFAULT_SETTINGS
};
