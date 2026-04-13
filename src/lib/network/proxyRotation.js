/**
 * Proxy Rotation Manager
 * 
 * Manages unique IP assignment to connections and automatic rotation.
 * Each connection gets a dedicated proxy pool with a unique external IP.
 * When a proxy fails or rotation interval expires, IPs are reassigned.
 * 
 * Strategies:
 *   - "round-robin": Rotate IPs across connections at fixed intervals
 *   - "sticky": Keep IP until it fails, then swap
 *   - "dedicated": Each connection permanently keeps its unique IP
 */

import { 
  getProxyPools, 
  getProviderConnections, 
  updateProxyPool, 
  updateProviderConnection 
} from "../models/index.js";

// In-memory state (resets on restart)
let rotationState = {
  enabled: false,
  strategy: "sticky",        // "round-robin" | "sticky" | "dedicated"
  rotationIntervalMs: 3600000, // 1 hour default
  minHealthyProxies: 2,       // minimum working proxies to maintain
  lastRotationAt: null,
  ipAssignments: new Map(),   // connectionId -> poolId
  knownIPs: new Map(),        // poolId -> last seen external IP
  failureCounts: new Map(),   // poolId -> consecutive failure count
  maxFailures: 3,             // failures before marking proxy dead
  initialized: false,
  logLevel: "info"            // "debug" | "info" | "warn" | "error"
};

const log = (level, ...args) => {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] >= levels[rotationState.logLevel]) {
    console.log(`[ProxyRotation][${level.toUpperCase()}]`, ...args);
  }
};

/**
 * Initialize the rotation manager
 * @param {Object} options - Configuration
 * @param {boolean} options.enabled - Enable rotation
 * @param {string} options.strategy - Rotation strategy
 * @param {number} options.rotationIntervalMs - Rotation interval in ms
 * @param {number} options.minHealthyProxies - Minimum healthy proxies
 * @param {number} options.maxFailures - Max failures before marking dead
 * @param {string} options.logLevel - Log level
 */
export function initRotationManager(options = {}) {
  rotationState.enabled = options.enabled ?? false;
  rotationState.strategy = options.strategy ?? "sticky";
  rotationState.rotationIntervalMs = options.rotationIntervalMs ?? 3600000;
  rotationState.minHealthyProxies = options.minHealthyProxies ?? 2;
  rotationState.maxFailures = options.maxFailures ?? 3;
  rotationState.logLevel = options.logLevel ?? "info";
  rotationState.initialized = true;
  
  log("info", `Initialized with strategy: ${rotationState.strategy}`, {
    enabled: rotationState.enabled,
    interval: `${rotationState.rotationIntervalMs / 60000}min`,
    minHealthy: rotationState.minHealthyProxies
  });
}

/**
 * Get current rotation state
 */
export function getRotationState() {
  return {
    enabled: rotationState.enabled,
    strategy: rotationState.strategy,
    rotationIntervalMs: rotationState.rotationIntervalMs,
    minHealthyProxies: rotationState.minHealthyProxies,
    lastRotationAt: rotationState.lastRotationAt,
    ipAssignments: Array.from(rotationState.ipAssignments.entries()),
    knownIPs: Array.from(rotationState.knownIPs.entries()),
    failureCounts: Array.from(rotationState.failureCounts.entries()),
    initialized: rotationState.initialized
  };
}

/**
 * Update rotation configuration
 */
export function updateRotationConfig(options = {}) {
  if (options.enabled !== undefined) rotationState.enabled = options.enabled;
  if (options.strategy !== undefined) rotationState.strategy = options.strategy;
  if (options.rotationIntervalMs !== undefined) rotationState.rotationIntervalMs = options.rotationIntervalMs;
  if (options.minHealthyProxies !== undefined) rotationState.minHealthyProxies = options.minHealthyProxies;
  if (options.maxFailures !== undefined) rotationState.maxFailures = options.maxFailures;
  if (options.logLevel !== undefined) rotationState.logLevel = options.logLevel;
  
  log("info", "Configuration updated", { 
    enabled: rotationState.enabled, 
    strategy: rotationState.strategy 
  });
}

/**
 * Assign unique IPs to all active connections.
 * 
 * Strategy behavior:
 * - "round-robin": Shuffles active pools, assigns one per connection cyclically
 * - "sticky": Keeps existing assignments, only reassigns failed/dead pools
 * - "dedicated": Assigns and locks - never rotates unless manual trigger
 * 
 * @returns {Object} { assigned: number, failed: number, assignments: Map }
 */
export async function assignUniqueIPs() {
  if (!rotationState.enabled) {
    log("warn", "Rotation disabled, skipping IP assignment");
    return { assigned: 0, failed: 0, assignments: [] };
  }

  log("info", "Starting unique IP assignment...");

  // Get all active connections and proxy pools
  const connections = await getProviderConnections();
  const activeConnections = connections.filter(c => c.isActive);
  const allPools = await getProxyPools();
  const activePools = allPools.filter(p => p.isActive !== false);

  if (activeConnections.length === 0) {
    log("info", "No active connections, nothing to assign");
    return { assigned: 0, failed: 0, assignments: [] };
  }

  if (activePools.length === 0) {
    log("error", "No active proxy pools available");
    return { assigned: 0, failed: activeConnections.length, assignments: [] };
  }

  log("info", `Found ${activeConnections.length} connections, ${activePools.length} active pools`);

  const assignments = [];
  const usedPoolIds = new Set();
  let assignedCount = 0;
  let failedCount = 0;

  // For sticky strategy, preserve existing assignments
  if (rotationState.strategy === "sticky") {
    for (const conn of activeConnections) {
      const existingPoolId = rotationState.ipAssignments.get(conn.id);
      if (existingPoolId) {
        const pool = allPools.find(p => p.id === existingPoolId);
        if (pool && pool.isActive !== false) {
          assignments.push({ connectionId: conn.id, poolId: existingPoolId });
          usedPoolIds.add(existingPoolId);
        } else {
          rotationState.ipAssignments.delete(conn.id);
        }
      }
    }
  }

  // For round-robin, shuffle available pools
  let availablePools = activePools.filter(p => !usedPoolIds.has(p.id));
  if (rotationState.strategy === "round-robin") {
    availablePools = shuffleArray([...availablePools]);
  }

  // Assign remaining connections
  let poolIndex = 0;
  for (const conn of activeConnections) {
    // Skip already assigned
    if (assignments.find(a => a.connectionId === conn.id)) continue;

    // Get a pool - reuse if not enough unique pools
    let pool;
    if (poolIndex < availablePools.length) {
      pool = availablePools[poolIndex];
      poolIndex++;
    } else if (rotationState.strategy === "dedicated" && usedPoolIds.size >= activeConnections.length) {
      // Dedicated mode: don't reuse pools, skip if not enough
      failedCount++;
      log("warn", `No unique pool for connection ${conn.name}`);
      continue;
    } else {
      // Cycle back to beginning (pool reuse)
      poolIndex = 0;
      pool = availablePools[0];
      poolIndex++;
    }

    if (pool) {
      assignments.push({ connectionId: conn.id, poolId: pool.id });
      usedPoolIds.add(pool.id);
      rotationState.ipAssignments.set(conn.id, pool.id);
      assignedCount++;
    } else {
      failedCount++;
    }
  }

  // Apply assignments to database
  for (const assignment of assignments) {
    try {
      const conn = activeConnections.find(c => c.id === assignment.connectionId);
      if (conn) {
        const updated = { ...conn };
        updated.providerSpecificData = {
          ...(conn.providerSpecificData || {}),
          proxyPoolId: assignment.poolId
        };
        await updateProviderConnection(assignment.connectionId, updated);
        log("debug", `Assigned ${conn.name} → pool ${assignment.poolId}`);
      }
    } catch (err) {
      log("error", `Failed to assign pool to connection: ${err.message}`);
      failedCount++;
    }
  }

  rotationState.lastRotationAt = new Date().toISOString();
  
  log("info", `IP assignment complete: ${assignedCount} assigned, ${failedCount} failed`);
  
  return {
    assigned: assignedCount,
    failed: failedCount,
    assignments,
    totalConnections: activeConnections.length,
    totalPools: activePools.length,
    uniqueIPs: usedPoolIds.size
  };
}

/**
 * Rotate IPs - force a new assignment regardless of strategy
 */
export async function forceRotate() {
  log("info", "Force rotation triggered");
  
  // Clear all existing assignments
  rotationState.ipAssignments.clear();
  
  return await assignUniqueIPs();
}

/**
 * Record a proxy failure and handle rotation
 * @param {string} poolId - The proxy pool that failed
 * @param {string} connectionId - The connection that experienced the failure
 */
export async function recordFailure(poolId, connectionId) {
  const failures = (rotationState.failureCounts.get(poolId) || 0) + 1;
  rotationState.failureCounts.set(poolId, failures);
  
  log("warn", `Proxy ${poolId} failed (${failures}/${rotationState.maxFailures})`);
  
  if (failures >= rotationState.maxFailures) {
    // Mark pool as inactive
    try {
      await updateProxyPool(poolId, { isActive: false, testStatus: "error" });
      log("warn", `Proxy pool ${poolId} marked as inactive after ${failures} failures`);
      
      // Remove assignment and reassign
      rotationState.ipAssignments.delete(connectionId);
      rotationState.failureCounts.delete(poolId);
      
      // Reassign this connection to a different pool
      await assignUniqueIPs();
    } catch (err) {
      log("error", `Failed to handle proxy failure: ${err.message}`);
    }
  }
}

/**
 * Record a proxy success (reset failure counter)
 */
export function recordSuccess(poolId) {
  if (rotationState.failureCounts.has(poolId)) {
    const prev = rotationState.failureCounts.get(poolId);
    if (prev > 0) {
      rotationState.failureCounts.set(poolId, 0);
      log("debug", `Proxy ${poolId} success, failure counter reset`);
    }
  }
}

/**
 * Check if rotation should run based on interval
 * @returns {boolean}
 */
export function shouldRotate() {
  if (!rotationState.enabled || !rotationState.lastRotationAt) return true;
  
  const elapsed = Date.now() - new Date(rotationState.lastRotationAt).getTime();
  return elapsed >= rotationState.rotationIntervalMs;
}

/**
 * Get rotation recommendations (dry run)
 */
export async function getRotationRecommendations() {
  const connections = await getProviderConnections();
  const activeConnections = connections.filter(c => c.isActive);
  const allPools = await getProxyPools();
  const activePools = allPools.filter(p => p.isActive !== false);
  
  const recommendations = {
    needsRotation: false,
    reasons: [],
    currentAssignments: {},
    availablePools: activePools.length,
    activeConnections: activeConnections.length,
    healthStatus: {}
  };

  // Check for dead pools still assigned
  for (const [connId, poolId] of rotationState.ipAssignments) {
    const pool = allPools.find(p => p.id === poolId);
    const conn = connections.find(c => c.id === connId);
    
    if (!pool || pool.isActive === false) {
      recommendations.needsRotation = true;
      recommendations.reasons.push(`Connection "${conn?.name}" assigned to dead pool`);
    }
    
    const failures = rotationState.failureCounts.get(poolId) || 0;
    if (failures > 0) {
      recommendations.healthStatus[poolId] = {
        failures,
        maxFailures: rotationState.maxFailures,
        critical: failures >= rotationState.maxFailures
      };
    }
  }

  // Check if enough unique pools
  if (activePools.length < activeConnections.length) {
    recommendations.needsRotation = true;
    recommendations.reasons.push(
      `Not enough unique pools: ${activePools.available} pools for ${activeConnections.length} connections`
    );
  }

  // Check rotation interval
  if (shouldRotate()) {
    recommendations.needsRotation = true;
    recommendations.reasons.push("Rotation interval elapsed");
  }

  return recommendations;
}

/**
 * Utility: shuffle array in place (Fisher-Yates)
 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Reset all rotation state
 */
export function resetRotationState() {
  rotationState.ipAssignments.clear();
  rotationState.knownIPs.clear();
  rotationState.failureCounts.clear();
  rotationState.lastRotationAt = null;
  log("info", "Rotation state reset");
}

export default {
  initRotationManager,
  getRotationState,
  updateRotationConfig,
  assignUniqueIPs,
  forceRotate,
  recordFailure,
  recordSuccess,
  shouldRotate,
  getRotationRecommendations,
  resetRotationState
};
