/**
 * V2Ray Rotation Scheduler
 * 
 * Replaces generic proxy rotation when Xray-backed pools are in use.
 * 
 * Orchestrates:
 * 1. v2rayNodeManager — fetches fresh nodes from GitHub sources
 * 2. xrayConfigBuilder — builds Xray config with per-port HTTP proxies
 * 3. xrayBridge — syncs pools to 9router, assigns unique IPs
 * 4. proxyHealth — tests nodes, detects dead ones
 * 
 * Runs on startup (if v2ray rotation enabled) and on cron intervals.
 */

import { initializeBridge, refreshBridge, testAllPools, assignUniquePools, getBridgeStatus } from "./xrayBridge.js";
import { getSettings } from "../models/index.js";

const log = (level, ...args) => {
  console.log(`[V2RayRotation][${level.toUpperCase()}]`, ...args);
};

let schedulerState = {
  active: false,
  started: false,
  intervals: {
    refreshMs: 3600000,      // 1 hour — fetch new nodes
    testMs: 300000,          // 5 min — test existing nodes
    assignMs: 3600000        // 1 hour — reassign unique IPs
  },
  timers: {},
  lastRun: {
    refresh: null,
    test: null,
    assign: null
  }
};

const DEFAULT_V2RAY_SETTINGS = {
  v2rayRotationEnabled: false,
  v2rayRefreshIntervalMs: 3600000,
  v2rayTestIntervalMs: 300000,
  v2rayAssignIntervalMs: 3600000,
  v2rayMaxPerSource: 60,
  v2rayMinNodes: 4,         // Minimum healthy nodes to maintain
  v2rayNodeTypes: ["vmess", "vless", "trojan", "shadowsocks"]
};

/**
 * Start the V2Ray rotation scheduler
 * Called from initializeApp.js when v2ray rotation is enabled
 */
export async function startV2RayRotation() {
  if (schedulerState.started) {
    log("warn", "Scheduler already started");
    return;
  }

  log("info", "Starting V2Ray rotation scheduler...");

  const settings = await getSettings();
  const enabled = settings.v2rayRotationEnabled ?? DEFAULT_V2RAY_SETTINGS.v2rayRotationEnabled;

  if (!enabled) {
    log("info", "V2Ray rotation disabled in settings");
    return;
  }

  schedulerState.intervals = {
    refreshMs: settings.v2rayRefreshIntervalMs ?? DEFAULT_V2RAY_SETTINGS.v2rayRefreshIntervalMs,
    testMs: settings.v2rayTestIntervalMs ?? DEFAULT_V2RAY_SETTINGS.v2rayTestIntervalMs,
    assignMs: settings.v2rayAssignIntervalMs ?? DEFAULT_V2RAY_SETTINGS.v2rayAssignIntervalMs
  };

  schedulerState.started = true;

  // Initial cycle
  try {
    await runFullCycle();
  } catch (err) {
    log("error", `Initial cycle failed: ${err.message}`);
  }

  // Start periodic timers
  startTimers();

  log("info", "Scheduler started", schedulerState.intervals);
}

/**
 * Stop the scheduler
 */
export function stopV2RayRotation() {
  if (!schedulerState.started) return;

  for (const [name, timer] of Object.entries(schedulerState.timers)) {
    if (timer) {
      clearInterval(timer);
      log("debug", `Cleared ${name} timer`);
    }
  }

  schedulerState.timers = {};
  schedulerState.started = false;
  log("info", "Scheduler stopped");
}

/**
 * Run a full rotation cycle:
 * 1. Refresh nodes from sources
 * 2. Deploy to Xray
 * 3. Sync proxy pools
 * 4. Test all pools
 * 5. Assign unique IPs to connections
 */
export async function runFullCycle() {
  if (schedulerState.active) {
    log("warn", "Cycle already running, skipping");
    return null;
  }

  schedulerState.active = true;
  log("info", "=== Starting full V2Ray rotation cycle ===");

  try {
    // Step 1: Refresh bridge (fetch + deploy + sync)
    log("info", "[1/3] Refreshing bridge (fetch + deploy + sync)...");
    const refreshResult = await refreshBridge();
    schedulerState.lastRun.refresh = new Date().toISOString();
    
    if (refreshResult.success) {
      log("info", `  Bridge: ${refreshResult.nodes} nodes deployed, ${refreshResult.pools?.poolsCreated || 0} pools created`);
    } else {
      log("warn", `  Bridge refresh failed: ${refreshResult.error}`);
    }

    // Step 2: Test all pools
    log("info", "[2/3] Testing all proxy pools...");
    const testResults = await testAllPools();
    schedulerState.lastRun.test = new Date().toISOString();
    
    const healthy = testResults.filter(r => r.status === "active");
    const dead = testResults.filter(r => r.status === "error");
    log("info", `  Pools: ${healthy.length} healthy, ${dead.length} dead`);

    // Step 3: Assign unique IPs
    log("info", "[3/3] Assigning unique IPs to connections...");
    const assignResult = await assignUniquePools();
    schedulerState.lastRun.assign = new Date().toISOString();
    log("info", `  Assign: ${assignResult.assigned} assigned, ${assignResult.failed} failed`);

    // Summary
    log("info", "=== Cycle complete ===");
    log("info", `  Nodes: ${refreshResult.nodes || 0} deployed`);
    log("info", `  Pools: ${healthy.length} healthy, ${dead.length} dead`);
    log("info", `  Connections: ${assignResult.assigned} covered, ${assignResult.failed} uncovered`);

    const bridgeStatus = getBridgeStatus();
    log("info", `  Bridge: ${bridgeStatus.deployedNodes} nodes, ${bridgeStatus.portMappings} ports, ${bridgeStatus.uniqueIPs} unique IPs`);

    return {
      success: true,
      nodes: refreshResult.nodes || 0,
      healthyPools: healthy.length,
      deadPools: dead.length,
      assigned: assignResult.assigned,
      failed: assignResult.failed,
      uniqueIPs: bridgeStatus.uniqueIPs
    };
  } catch (err) {
    log("error", `Cycle failed: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    schedulerState.active = false;
  }
}

/**
 * Start periodic timers
 */
function startTimers() {
  // Refresh timer (fetch new nodes)
  schedulerState.timers.refresh = setInterval(async () => {
    try {
      log("info", "[Scheduled] Refreshing nodes...");
      await refreshBridge();
      schedulerState.lastRun.refresh = new Date().toISOString();
    } catch (err) {
      log("error", `Scheduled refresh failed: ${err.message}`);
    }
  }, schedulerState.intervals.refreshMs);

  // Test timer (health check)
  schedulerState.timers.test = setInterval(async () => {
    try {
      log("info", "[Scheduled] Testing pools...");
      await testAllPools();
      schedulerState.lastRun.test = new Date().toISOString();
    } catch (err) {
      log("error", `Scheduled test failed: ${err.message}`);
    }
  }, schedulerState.intervals.testMs);

  // Assign timer (unique IPs)
  schedulerState.timers.assign = setInterval(async () => {
    try {
      log("info", "[Scheduled] Assigning unique IPs...");
      await assignUniquePools();
      schedulerState.lastRun.assign = new Date().toISOString();
    } catch (err) {
      log("error", `Scheduled assign failed: ${err.message}`);
    }
  }, schedulerState.intervals.assignMs);

  // Unref timers so they don't block process exit
  for (const timer of Object.values(schedulerState.timers)) {
    if (timer?.unref) timer.unref();
  }
}

/**
 * Get scheduler status
 */
export function getV2RaySchedulerStatus() {
  return {
    active: schedulerState.active,
    started: schedulerState.started,
    intervals: schedulerState.intervals,
    lastRun: schedulerState.lastRun,
    bridge: getBridgeStatus()
  };
}

/**
 * Trigger manual cycle
 */
export async function triggerManualCycle() {
  log("info", "Manual V2Ray rotation cycle triggered");
  return await runFullCycle();
}

export default {
  startV2RayRotation,
  stopV2RayRotation,
  runFullCycle,
  triggerManualCycle,
  getV2RaySchedulerStatus,
  DEFAULT_V2RAY_SETTINGS
};
