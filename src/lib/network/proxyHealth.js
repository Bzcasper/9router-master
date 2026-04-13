/**
 * Proxy Health Checker
 * 
 * Tests all proxy pools, detects external IPs, marks dead proxies,
 * and triggers rotation when needed.
 */

import { ProxyAgent } from "undici";
import { getProxyPools, updateProxyPool } from "../models/index.js";
import { recordFailure, recordSuccess } from "./proxyRotation.js";

const TEST_URL = "https://httpbin.org/ip";
const TEST_TIMEOUT_MS = 8000;
const HEALTH_CHECK_INTERVAL_MS = 300000; // 5 minutes

let healthCheckState = {
  running: false,
  lastCheckAt: null,
  lastResults: [],
  intervalId: null
};

const log = (level, ...args) => {
  console.log(`[ProxyHealth][${level.toUpperCase()}]`, ...args);
};

/**
 * Test a single proxy pool and return result
 * @param {Object} pool - Proxy pool object
 * @returns {Object} { poolId, proxyUrl, status, latency, externalIP, error }
 */
export async function testProxyPool(pool) {
  const startTime = Date.now();
  const result = {
    poolId: pool.id,
    name: pool.name,
    proxyUrl: pool.proxyUrl,
    type: pool.type || "http",
    status: "unknown",
    latency: 0,
    externalIP: null,
    error: null
  };

  if (pool.type === "vercel") {
    // Vercel relay pools need special testing (handled by existing API route)
    result.status = "skipped";
    result.error = "Vercel relay pools tested via API route";
    return result;
  }

  try {
    const proxyUrl = pool.proxyUrl;
    if (!proxyUrl || !proxyUrl.startsWith("http")) {
      throw new Error(`Invalid proxy URL: ${proxyUrl}`);
    }

    const dispatcher = new ProxyAgent(proxyUrl);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

    const response = await fetch(TEST_URL, {
      method: "GET",
      dispatcher,
      signal: controller.signal,
      headers: { "User-Agent": "9Router-HealthCheck/1.0" }
    });

    clearTimeout(timeoutId);
    result.latency = Date.now() - startTime;

    if (response.ok) {
      const data = await response.json();
      result.externalIP = data.origin || data.ip;
      result.status = "active";
    } else {
      result.status = "error";
      result.error = `HTTP ${response.status}`;
    }
  } catch (err) {
    result.latency = Date.now() - startTime;
    result.status = "error";
    result.error = err.name === "AbortError" ? "Timeout" : err.message;
  }

  return result;
}

/**
 * Test all active proxy pools
 * @param {Object} options
 * @param {boolean} options.testAll - Test all pools, not just active ones
 * @param {boolean} options.triggerRotation - Auto-rotate if dead pools found
 * @returns {Array} Test results
 */
export async function checkAllProxies(options = {}) {
  if (healthCheckState.running) {
    log("warn", "Health check already running, skipping");
    return healthCheckState.lastResults;
  }

  healthCheckState.running = true;
  log("info", "Starting health check...");

  const pools = await getProxyPools();
  const poolsToTest = options.testAll ? pools : pools.filter(p => p.isActive !== false);

  log("info", `Testing ${poolsToTest.length}/${pools.length} proxy pools`);

  // Test in parallel with concurrency limit
  const results = [];
  const concurrency = 5;
  
  for (let i = 0; i < poolsToTest.length; i += concurrency) {
    const batch = poolsToTest.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(testProxyPool));
    results.push(...batchResults);
    
    // Small delay between batches
    if (i + concurrency < poolsToTest.length) {
      await sleep(500);
    }
  }

  // Update pool states based on results
  const deadPools = [];
  const healthyPools = [];

  for (const result of results) {
    const updates = {
      testStatus: result.status === "active" ? "active" : "error",
      lastTestedAt: new Date().toISOString(),
      lastError: result.error
    };

    if (result.status === "active") {
      updates.isActive = true;
      healthyPools.push(result);
      recordSuccess(result.poolId);
    } else {
      deadPools.push(result);
      await recordFailure(result.poolId, null);
      
      // Check failure count to determine if pool should be deactivated
      const pool = pools.find(p => p.id === result.poolId);
      if (pool && pool.testStatus === "error" && pool.lastError) {
        // Will be deactivated by rotation manager after maxFailures
      }
    }

    try {
      await updateProxyPool(result.poolId, updates);
    } catch (err) {
      log("error", `Failed to update pool ${result.poolId}: ${err.message}`);
    }
  }

  healthCheckState.lastCheckAt = new Date().toISOString();
  healthCheckState.lastResults = results;
  healthCheckState.running = false;

  log("info", `Health check complete: ${healthyPools.length} healthy, ${deadPools.length} dead`);

  return results;
}

/**
 * Start automated health checking
 * @param {Object} options
 * @param {number} options.intervalMs - Check interval in milliseconds (default: 5 min)
 */
export function startAutomatedHealthCheck(options = {}) {
  if (healthCheckState.intervalId) {
    log("warn", "Automated health check already running");
    return;
  }

  const intervalMs = options.intervalMs ?? HEALTH_CHECK_INTERVAL_MS;
  
  log("info", `Starting automated health check (every ${intervalMs / 60000}min)`);

  // Run immediately
  checkAllProxies().catch(err => {
    log("error", `Initial health check failed: ${err.message}`);
  });

  // Schedule periodic checks
  healthCheckState.intervalId = setInterval(async () => {
    try {
      await checkAllProxies({ triggerRotation: true });
    } catch (err) {
      log("error", `Scheduled health check failed: ${err.message}`);
    }
  }, intervalMs);
}

/**
 * Stop automated health checking
 */
export function stopAutomatedHealthCheck() {
  if (healthCheckState.intervalId) {
    clearInterval(healthCheckState.intervalId);
    healthCheckState.intervalId = null;
    log("info", "Automated health check stopped");
  }
}

/**
 * Get health check status
 */
export function getHealthCheckStatus() {
  return {
    running: healthCheckState.running,
    lastCheckAt: healthCheckState.lastCheckAt,
    lastResults: healthCheckState.lastResults,
    automated: healthCheckState.intervalId !== null
  };
}

/**
 * Get healthy proxy pools (for rotation assignment)
 * @returns {Array} Array of healthy pool objects
 */
export async function getHealthyPools() {
  const pools = await getProxyPools();
  return pools.filter(p => 
    p.isActive !== false && 
    p.testStatus !== "error"
  );
}

/**
 * Get unique IPs from healthy pools
 * @returns {Map} poolId -> externalIP
 */
export async function getUniqueIPs() {
  const healthyPools = await getHealthyPools();
  const ipMap = new Map();

  for (const pool of healthyPools) {
    // Quick test to get IP if not known
    if (!pool.lastTestedAt || (Date.now() - new Date(pool.lastTestedAt).getTime()) > 3600000) {
      const result = await testProxyPool(pool);
      if (result.status === "active") {
        ipMap.set(pool.id, result.externalIP);
      }
    } else if (pool.testStatus === "active") {
      ipMap.set(pool.id, "verified");
    }
  }

  return ipMap;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  testProxyPool,
  checkAllProxies,
  startAutomatedHealthCheck,
  stopAutomatedHealthCheck,
  getHealthCheckStatus,
  getHealthyPools,
  getUniqueIPs
};
