/**
 * Xray Bridge
 * 
 * Bridges Xray HTTP proxy ports to 9router proxy pools.
 * 
 * Responsibilities:
 * 1. Map each Xray HTTP inbound port → a 9router proxy pool
 * 2. Auto-create/update proxy pools when Xray nodes change
 * 3. Test nodes via their Xray HTTP port to detect external IP
 * 4. Report failures back to the rotation system
 * 
 * Flow:
 *   v2ray nodes → Xray config → HTTP ports → 9router proxy pools → connections
 */

import { fetchAllNodes } from "./v2rayNodeManager.js";
import { buildXrayConfig, validateConfig, writeConfig, reloadXray, getCurrentConfig, SOCKS_PORT } from "./xrayConfigBuilder.js";
import { getProviderConnections, updateProviderConnection, getProxyPools, createProxyPool, updateProxyPool, deleteProxyPool } from "../models/index.js";

const BASE_PORT = 10810;
const TEST_URL = "https://httpbin.org/ip";
const TEST_TIMEOUT = 8000;

const log = (level, ...args) => {
  console.log(`[XrayBridge][${level.toUpperCase()}]`, ...args);
};

// In-memory state
let bridgeState = {
  active: false,
  deployedNodes: [],      // Currently deployed v2ray nodes
  portToPoolMap: {},      // port → poolId
  poolToPortMap: {},      // poolId → port
  nodeIPs: {},            // poolId → external IP
  lastRefresh: null,
  lastTest: null
};

/**
 * Initialize the Xray bridge system
 * Fetches nodes, deploys to Xray, creates 9router proxy pools
 */
export async function initializeBridge(options = {}) {
  if (bridgeState.active) {
    log("warn", "Bridge already active, refreshing...");
    return await refreshBridge(options);
  }

  log("info", "Initializing Xray bridge...");

  // Fetch fresh nodes
  const { nodes, stats } = await fetchAllNodes({
    maxPerSource: options.maxPerSource ?? 60,
    deduplicate: true
  });

  if (nodes.length === 0) {
    log("error", "No nodes fetched, cannot initialize bridge");
    return { success: false, error: "No nodes fetched" };
  }

  log("info", `Fetched ${nodes.length} nodes, deploying to Xray...`);

  // Deploy to Xray
  const deployResult = await deployToXray(nodes);
  if (!deployResult.success) {
    return deployResult;
  }

  // Sync proxy pools with Xray ports
  const syncResult = await syncProxyPools(deployResult.ports);

  bridgeState.active = true;
  bridgeState.deployedNodes = nodes;
  bridgeState.lastRefresh = new Date().toISOString();

  log("info", `Bridge initialized: ${syncResult.poolsCreated} pools created, ${syncResult.poolsRemoved} removed`);

  return {
    success: true,
    nodes: nodes.length,
    pools: syncResult,
    deploy: deployResult,
    stats
  };
}

/**
 * Refresh the bridge: fetch new nodes, redeploy, sync pools
 */
export async function refreshBridge(options = {}) {
  log("info", "Refreshing bridge...");

  const { nodes, stats } = await fetchAllNodes({
    maxPerSource: options.maxPerSource ?? 60,
    deduplicate: true
  });

  if (nodes.length === 0) {
    log("warn", "No nodes fetched, keeping existing config");
    return { success: false, error: "No nodes fetched" };
  }

  // Deploy new nodes
  const deployResult = await deployToXray(nodes);
  if (!deployResult.success) {
    return deployResult;
  }

  // Sync pools
  const syncResult = await syncProxyPools(deployResult.ports);

  bridgeState.deployedNodes = nodes;
  bridgeState.lastRefresh = new Date().toISOString();

  return {
    success: true,
    nodes: nodes.length,
    pools: syncResult,
    deploy: deployResult,
    stats
  };
}

/**
 * Deploy nodes to Xray
 */
async function deployToXray(nodes) {
  const config = buildXrayConfig(nodes, { basePort: BASE_PORT });
  const validation = validateConfig(config);

  if (!validation.valid) {
    log("error", "Config validation failed:", validation.errors);
    return { success: false, errors: validation.errors };
  }

  writeConfig(config);
  const reloadResult = await reloadXray();

  return {
    success: reloadResult.success,
    deployed: nodes.length,
    ports: config.inbounds
      .filter(ib => ib.protocol === "http")
      .map(ib => ({ port: ib.port, tag: ib.tag })),
    validation: validation
  };
}

/**
 * Sync 9router proxy pools with Xray HTTP ports
 * Creates new pools for new ports, removes orphaned pools
 */
async function syncProxyPools(ports) {
  const existingPools = await getProxyPools();
  const connections = await getProviderConnections();
  
  // Find pools that were created by this bridge (tagged with "xray-bridge")
  const bridgePools = existingPools.filter(p => p.type === "xray");
  const activePortSet = new Set(ports.map(p => p.port));
  const activePoolIds = new Set();
  
  let poolsCreated = 0;
  let poolsUpdated = 0;
  let poolsRemoved = 0;

  for (const { port, tag } of ports) {
    // Find existing pool for this port
    const existingPool = bridgePools.find(p => {
      try {
        const urlPort = new URL(p.proxyUrl).port;
        return parseInt(urlPort) === port;
      } catch {
        return false;
      }
    });

    const poolUrl = `http://127.0.0.1:${port}`;

    if (existingPool) {
      // Update existing pool
      await updateProxyPool(existingPool.id, {
        isActive: true,
        proxyUrl: poolUrl,
        updatedAt: new Date().toISOString()
      });
      activePoolIds.add(existingPool.id);
      bridgeState.portToPoolMap[port] = existingPool.id;
      bridgeState.poolToPortMap[existingPool.id] = port;
      poolsUpdated++;
    } else {
      // Create new pool
      try {
        const pool = await createProxyPool({
          name: `xray-${tag}`,
          proxyUrl: poolUrl,
          noProxy: "localhost,127.0.0.1,.internal",
          type: "xray",
          isActive: true,
          strictProxy: false,
          testStatus: "unknown"
        });
        activePoolIds.add(pool.id);
        bridgeState.portToPoolMap[port] = pool.id;
        bridgeState.poolToPortMap[pool.id] = port;
        poolsCreated++;
        log("debug", `Created pool: ${pool.name} → ${poolUrl}`);
      } catch (err) {
        log("error", `Failed to create pool for port ${port}: ${err.message}`);
      }
    }
  }

  // Remove orphaned bridge pools (not bound to any connection)
  const boundPoolIds = new Set();
  for (const conn of connections) {
    if (conn.providerSpecificData?.proxyPoolId) {
      boundPoolIds.add(conn.providerSpecificData.proxyPoolId);
    }
  }

  for (const pool of bridgePools) {
    if (!activePoolIds.has(pool.id) && !boundPoolIds.has(pool.id)) {
      try {
        await deleteProxyPool(pool.id);
        delete bridgeState.portToPoolMap[bridgeState.poolToPortMap[pool.id]];
        delete bridgeState.poolToPortMap[pool.id];
        poolsRemoved++;
        log("debug", `Removed orphaned pool: ${pool.name}`);
      } catch (err) {
        log("error", `Failed to remove pool ${pool.id}: ${err.message}`);
      }
    } else if (!activePoolIds.has(pool.id)) {
      // Mark inactive but keep (bound to connection)
      await updateProxyPool(pool.id, { isActive: false, testStatus: "error" });
    }
  }

  return { poolsCreated, poolsUpdated, poolsRemoved, totalActive: activePoolIds.size };
}

/**
 * Test all active pools via their Xray HTTP port
 * Detects external IP and latency
 */
export async function testAllPools() {
  const pools = await getProxyPools();
  const xrayPools = pools.filter(p => p.type === "xray" && p.isActive !== false);

  log("info", `Testing ${xrayPools.length} Xray proxy pools...`);

  const { ProxyAgent } = await import("undici");
  const results = [];

  for (const pool of xrayPools) {
    const start = Date.now();
    const result = {
      poolId: pool.id,
      name: pool.name,
      proxyUrl: pool.proxyUrl,
      status: "unknown",
      latency: 0,
      externalIP: null,
      error: null
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT);

      const dispatcher = new ProxyAgent(pool.proxyUrl);
      const res = await fetch(TEST_URL, {
        dispatcher,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      result.latency = Date.now() - start;

      if (res.ok) {
        const data = await res.json();
        result.externalIP = data.origin || data.ip;
        result.status = "active";
        bridgeState.nodeIPs[pool.id] = result.externalIP;

        await updateProxyPool(pool.id, {
          testStatus: "active",
          lastTestedAt: new Date().toISOString(),
          lastError: null,
          isActive: true
        });
      } else {
        result.status = "error";
        result.error = `HTTP ${res.status}`;
        await updateProxyPool(pool.id, {
          testStatus: "error",
          lastTestedAt: new Date().toISOString(),
          lastError: result.error
        });
      }
    } catch (err) {
      result.latency = Date.now() - start;
      result.status = "error";
      result.error = err.name === "AbortError" ? "Timeout" : err.message;
      await updateProxyPool(pool.id, {
        testStatus: "error",
        lastTestedAt: new Date().toISOString(),
        lastError: result.error
      });
    }

    results.push(result);
  }

  bridgeState.lastTest = new Date().toISOString();

  const healthy = results.filter(r => r.status === "active");
  const dead = results.filter(r => r.status === "error");

  log("info", `Test complete: ${healthy.length} healthy, ${dead.length} dead`);

  return results;
}

/**
 * Get a proxy pool for a specific connection
 * Uses round-robin or sticky assignment
 */
export async function getPoolForConnection(connectionId) {
  // Check existing assignment
  const connections = await getProviderConnections();
  const conn = connections.find(c => c.id === connectionId);
  
  if (conn?.providerSpecificData?.proxyPoolId) {
    const poolId = conn.providerSpecificData.proxyPoolId;
    const pools = await getProxyPools();
    const pool = pools.find(p => p.id === poolId && p.isActive !== false);
    if (pool) return pool;
  }

  // Assign from available pools
  const pools = await getProxyPools();
  const activePools = pools.filter(p => p.type === "xray" && p.isActive !== false);
  
  if (activePools.length === 0) return null;

  // Round-robin: pick least recently used
  const pool = activePools.sort((a, b) => {
    const aTime = a.lastTestedAt ? new Date(a.lastTestedAt).getTime() : 0;
    const bTime = b.lastTestedAt ? new Date(b.lastTestedAt).getTime() : 0;
    return aTime - bTime;
  })[0];

  return pool;
}

/**
 * Assign unique pools to all active connections
 * One pool per connection for IP isolation
 */
export async function assignUniquePools() {
  const connections = await getProviderConnections();
  const activeConnections = connections.filter(c => c.isActive);
  const pools = await getProxyPools();
  const activePools = pools.filter(p => p.type === "xray" && p.isActive !== false);

  if (activePools.length === 0) {
    log("error", "No active Xray pools available");
    return { assigned: 0, failed: activeConnections.length };
  }

  let assigned = 0;
  let failed = 0;
  const usedPoolIds = new Set();

  for (const conn of activeConnections) {
    // Skip already assigned
    if (conn.providerSpecificData?.proxyPoolId) {
      const pool = activePools.find(p => p.id === conn.providerSpecificData.proxyPoolId);
      if (pool) {
        usedPoolIds.add(pool.id);
        continue;
      }
    }

    // Find unused pool
    let pool = activePools.find(p => !usedPoolIds.has(p.id));
    if (!pool) {
      // Cycle: reuse pools round-robin
      pool = activePools[failed % activePools.length];
    }

    if (pool) {
      try {
        await updateProviderConnection(conn.id, {
          ...conn,
          providerSpecificData: {
            ...(conn.providerSpecificData || {}),
            proxyPoolId: pool.id
          }
        });
        usedPoolIds.add(pool.id);
        assigned++;
        log("debug", `Assigned ${conn.name} → ${pool.name} (${pool.proxyUrl})`);
      } catch (err) {
        log("error", `Failed to assign pool to ${conn.name}: ${err.message}`);
        failed++;
      }
    } else {
      failed++;
    }
  }

  log("info", `Unique pool assignment: ${assigned} assigned, ${failed} failed (${activePools.length} pools, ${activeConnections.length} connections)`);

  return { assigned, failed, totalConnections: activeConnections.length, totalPools: activePools.length };
}

/**
 * Get bridge status and stats
 */
export function getBridgeStatus() {
  return {
    active: bridgeState.active,
    deployedNodes: bridgeState.deployedNodes.length,
    portMappings: Object.keys(bridgeState.portToPoolMap).length,
    knownIPs: Object.keys(bridgeState.nodeIPs).length,
    uniqueIPs: new Set(Object.values(bridgeState.nodeIPs)).size,
    lastRefresh: bridgeState.lastRefresh,
    lastTest: bridgeState.lastTest
  };
}

/**
 * Reset bridge state
 */
export function resetBridge() {
  bridgeState = {
    active: false,
    deployedNodes: [],
    portToPoolMap: {},
    poolToPortMap: {},
    nodeIPs: {},
    lastRefresh: null,
    lastTest: null
  };
  log("info", "Bridge state reset");
}

export default {
  initializeBridge,
  refreshBridge,
  testAllPools,
  getPoolForConnection,
  assignUniquePools,
  getBridgeStatus,
  resetBridge
};
