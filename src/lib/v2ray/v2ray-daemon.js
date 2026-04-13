#!/usr/bin/env node
/**
 * V2Ray Rotation Daemon
 * 
 * Standalone daemon that:
 * 1. Fetches free v2ray/vless/trojan nodes from GitHub sources
 * 2. Builds dynamic Xray config with per-port HTTP proxies
 * 3. Reloads Xray
 * 4. Syncs proxy pools to 9router's db.json
 * 5. Assigns unique IPs to each 9router connection
 * 6. Runs on a timer to keep nodes fresh
 * 
 * NO dependency on 9router's API — works directly with db.json and Xray.
 */

const { exec, execSync, spawn } = require("child_process");
const { readFileSync, writeFileSync, existsSync } = require("fs");
const { join } = require("path");
const { createHash } = require("crypto");
const crypto = require("crypto");

// ─── Config ────────────────────────────────────────────────────────────────

const DB_PATH = join(process.env.HOME, ".9router", "db.json");
const XRAY_CONFIG = "/usr/local/etc/xray/config.json";
const XRAY_BIN = "/usr/local/bin/xray";
const BASE_HTTP_PORT = 10810;
const TEST_URL = "https://httpbin.org/ip";
const TEST_TIMEOUT = 8000;
const CYCLE_INTERVAL_MS = 3600000;     // 1 hour: full refresh
const HEALTH_INTERVAL_MS = 300000;      // 5 min: test pools
const MAX_NODES_PER_SOURCE = 30;
const MAX_TOTAL_NODES = 40;            // Cap total nodes to avoid Xray overload

const SUBSCRIPTION_SOURCES = [
  { name: "Pawdroid", url: "https://raw.githubusercontent.com/Pawdroid/Free-servers/main/sub" },
  { name: "Ermaozi", url: "https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt" },
  { name: "Mfuu", url: "https://raw.githubusercontent.com/mfuu/v2ray/master/v2ray" },
  { name: "Aiboboxx", url: "https://raw.githubusercontent.com/aiboboxx/v2rayfree/main/v2" },
  { name: "NoMoreWalls", url: "https://raw.githubusercontent.com/peasoft/NoMoreWalls/master/list.txt" },
  { name: "Roozk", url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/V2RAY_RAW.txt" },
];

let state = {
  deployedNodes: [],
  portMap: {},       // port → poolId
  poolMap: {},       // poolId → { port, name, ip }
  running: false,
  cycleCount: 0,
};

const log = (level, ...args) => {
  console.log(`[${new Date().toISOString()}][${level.toUpperCase()}]`, ...args);
};

// ─── DB Helpers ─────────────────────────────────────────────────────────────

function loadDB() {
  return JSON.parse(readFileSync(DB_PATH, "utf-8"));
}

function saveDB(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 
    createHash("md5").update(Date.now().toString() + Math.random()).digest("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}

// ─── Node Fetching ──────────────────────────────────────────────────────────

async function fetchURL(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

function decodeSubscription(text) {
  // Try base64 decode first
  try {
    const decoded = Buffer.from(text.trim(), "base64").toString("utf-8");
    if (decoded.includes("://")) return decoded;
  } catch {}
  return text;
}

function parseShareURLs(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const urls = [];
  for (const line of lines) {
    if (line.match(/^(vmess|vless|trojan|ss|ssr|hysteria2?):\/\//)) {
      urls.push(line);
      continue;
    }
    try {
      const decoded = Buffer.from(line, "base64").toString("utf-8");
      if (decoded.match(/^(vmess|vless|trojan|ss|ssr|hysteria2?):\/\//)) {
        urls.push(decoded);
      }
    } catch {}
  }
  return urls;
}

function parseVmess(url) {
  try {
    const cfg = JSON.parse(Buffer.from(url.replace("vmess://", ""), "base64").toString());
    return {
      protocol: "vmess",
      tag: `vmess-${cfg.ps || cfg.add}-${cfg.port}`,
      settings: {
        vnext: [{
          address: cfg.add,
          port: parseInt(cfg.port),
          users: [{ id: cfg.id, alterId: parseInt(cfg.aid) || 0, security: cfg.scy || "auto" }]
        }]
      },
      streamSettings: {
        network: cfg.net || "tcp",
        ...(cfg.tls === "tls" ? { security: "tls", tlsSettings: { serverName: cfg.sni || cfg.add } } : {}),
        ...(cfg.net === "ws" ? { wsSettings: { path: cfg.path || "/", headers: { Host: cfg.host || cfg.add } } } : {}),
      }
    };
  } catch { return null; }
}

function parseVless(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams;
    const sec = p.get("security") || "none";
    return {
      protocol: "vless",
      tag: `vless-${u.hostname}-${u.port}`,
      settings: {
        vnext: [{
          address: u.hostname,
          port: parseInt(u.port),
          users: [{ id: u.username, encryption: p.get("encryption") || "none", flow: p.get("flow") || "" }]
        }]
      },
      streamSettings: {
        network: p.get("type") || "tcp",
        security: sec,
        ...(sec === "tls" ? { tlsSettings: { serverName: p.get("sni") || u.hostname } } : {}),
        ...(sec === "reality" ? { realitySettings: { serverName: p.get("sni") || u.hostname, publicKey: p.get("pbk") || "", shortId: p.get("sid") || "" } } : {}),
        ...(p.get("type") === "ws" ? { wsSettings: { path: p.get("path") || "/", headers: { Host: p.get("host") || "" } } } : {}),
      }
    };
  } catch { return null; }
}

function parseTrojan(url) {
  try {
    const u = new URL(url);
    const pass = u.pathname ? u.pathname.replace("/", "") : u.username;
    return {
      protocol: "trojan",
      tag: `trojan-${u.hostname}-${u.port}`,
      settings: {
        servers: [{ address: u.hostname, port: parseInt(u.port), password: pass }]
      },
      streamSettings: { network: "tcp", security: "tls", tlsSettings: { serverName: u.hostname } }
    };
  } catch { return null; }
}

function parseShadowsocks(url) {
  try {
    const inner = url.replace("ss://", "");
    const atIdx = inner.indexOf("@");
    if (atIdx > 0) {
      const decoded = Buffer.from(inner.substring(0, atIdx), "base64").toString("utf-8");
      const colonIdx = decoded.indexOf(":");
      const method = decoded.substring(0, colonIdx);
      const password = decoded.substring(colonIdx + 1);
      const [host, port] = inner.substring(atIdx + 1).split(":");
      
      // Filter out unsupported ciphers in Xray v26+
      const unsupported = ["aes-256-cfb", "aes-128-cfb", "rc4-md5", "chacha20", "salsa20"];
      if (unsupported.includes(method.toLowerCase())) return null;
      
      return {
        protocol: "shadowsocks",
        tag: `ss-${host}-${port}`,
        settings: { servers: [{ address: host.split("#")[0], port: parseInt(port), method, password }] }
      };
    }
  } catch { return null; }
}

function parseShareUrl(url) {
  if (url.startsWith("vmess://")) return parseVmess(url);
  if (url.startsWith("vless://")) return parseVless(url);
  if (url.startsWith("trojan://")) return parseTrojan(url);
  if (url.startsWith("ss://")) return parseShadowsocks(url);
  return null;
}

async function fetchAllNodes() {
  log("info", `Fetching nodes from ${SUBSCRIPTION_SOURCES.length} sources...`);
  const allNodes = [];
  const seenUrls = new Set();

  for (const source of SUBSCRIPTION_SOURCES) {
    const text = await fetchURL(source.url);
    if (!text) { log("warn", `  ${source.name}: fetch failed`); continue; }
    
    const decoded = decodeSubscription(text);
    const urls = parseShareURLs(decoded).slice(0, MAX_NODES_PER_SOURCE);
    let parsed = 0;
    
    for (const url of urls) {
      if (seenUrls.has(url)) continue;
      const node = parseShareUrl(url);
      if (!node) continue;
      seenUrls.add(url);
      
      // Deduplicate tags
      node.tag = `${node.tag}-${createHash("md5").update(url).digest("hex").slice(0, 6)}`;
      allNodes.push(node);
      parsed++;
    }
    log("info", `  ${source.name}: ${parsed} nodes`);
  }

  log("info", `Total unique nodes: ${allNodes.length}`);
  const byProtocol = {};
  for (const n of allNodes) byProtocol[n.protocol] = (byProtocol[n.protocol] || 0) + 1;
  log("info", `  By protocol: ${JSON.stringify(byProtocol)}`);
  
  // Cap total nodes
  if (allNodes.length > MAX_TOTAL_NODES) {
    log("info", `  Capping to ${MAX_TOTAL_NODES} nodes (from ${allNodes.length})`);
    return allNodes.slice(0, MAX_TOTAL_NODES);
  }
  
  return allNodes;
}

// ─── Xray Config ────────────────────────────────────────────────────────────

function buildXrayConfig(nodes) {
  const inbounds = [];
  const outbounds = [];
  const rules = [];

  // SOCKS inbound
  inbounds.push({
    port: 10808, listen: "127.0.0.1", protocol: "socks",
    settings: { auth: "noauth", udp: true }, tag: "socks-in"
  });

  // One HTTP inbound + one outbound per node
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const port = BASE_HTTP_PORT + i;
    
    inbounds.push({
      port, listen: "127.0.0.1", protocol: "http",
      settings: {}, tag: `http-${port}`
    });

    outbounds.push({ ...node, tag: node.tag });

    rules.push({
      type: "field",
      inboundTag: [`http-${port}`],
      outboundTag: node.tag
    });
  }

  // Default routes
  outbounds.push({ protocol: "freedom", tag: "direct", settings: {} });
  outbounds.push({ protocol: "blackhole", tag: "block" });
  
  rules.push({ type: "field", inboundTag: ["socks-in"], outboundTag: nodes.length > 0 ? nodes[0].tag : "direct" });
  rules.push({ type: "field", ip: ["geoip:private"], outboundTag: "direct" });

  return {
    log: { loglevel: "warning" },
    inbounds, outbounds,
    routing: { domainStrategy: "IPIfNonMatch", rules }
  };
}

function writeXrayConfig(config) {
  const tempPath = "/tmp/xray-config.json";
  writeFileSync(tempPath, JSON.stringify(config, null, 2));
  try {
    execSync(`sudo cp ${tempPath} ${XRAY_CONFIG}`, { encoding: "utf8" });
    log("info", `Xray config written: ${config.inbounds.length} inbounds, ${config.outbounds.length} outbounds`);
  } catch (err) {
    log("error", `Failed to write Xray config: ${err.message}`);
    throw err;
  }
}

async function reloadXray() {
  try {
    execSync(`sudo cp ${XRAY_CONFIG} /tmp/xray-config-backup.json`, { encoding: "utf8" });
  } catch {}
  
  try {
    execSync("sudo systemctl restart xray", { encoding: "utf8" });
    await new Promise(r => setTimeout(r, 3000));
    
    try {
      execSync("sudo systemctl is-active xray", { encoding: "utf8" });
      log("info", "Xray reloaded and running");
      return true;
    } catch {
      log("warn", "Xray didn't start, restoring backup");
      execSync(`sudo cp /tmp/xray-config-backup.json ${XRAY_CONFIG}`, { encoding: "utf8" });
      execSync("sudo systemctl restart xray", { encoding: "utf8" });
      return false;
    }
  } catch (err) {
    log("error", `Xray reload failed: ${err.message}`);
    try {
      execSync(`sudo cp /tmp/xray-config-backup.json ${XRAY_CONFIG}`, { encoding: "utf8" });
      execSync("sudo systemctl restart xray", { encoding: "utf8" });
    } catch {}
    return false;
  }
}

// ─── Health Testing ─────────────────────────────────────────────────────────

async function testPort(port) {
  const start = Date.now();
  try {
    const { ProxyAgent } = require("undici");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT);
    
    const dispatcher = new ProxyAgent(`http://127.0.0.1:${port}`);
    const res = await fetch(TEST_URL, { dispatcher, signal: controller.signal });
    clearTimeout(timeout);
    
    if (res.ok) {
      const data = await res.json();
      return { status: "active", latency: Date.now() - start, externalIP: data.origin || data.ip };
    }
    return { status: "error", latency: Date.now() - start, error: `HTTP ${res.status}` };
  } catch (err) {
    return { status: "error", latency: Date.now() - start, error: err.message };
  }
}

// ─── 9router DB Sync ────────────────────────────────────────────────────────

function syncProxyPools(nodes, testResults) {
  const db = loadDB();
  if (!db.proxyPools) db.proxyPools = [];
  
  const now = new Date().toISOString();
  const portSet = new Set();
  const created = [];
  const updated = [];
  const deactivated = [];

  for (let i = 0; i < nodes.length; i++) {
    const port = BASE_HTTP_PORT + i;
    const node = nodes[i];
    const portKey = `port-${port}`;
    portSet.add(portKey);

    const poolUrl = `http://127.0.0.1:${port}`;
    const testName = testResults[i]?.externalIP || "unknown";
    const testStatus = testResults[i]?.status === "active" ? "active" : "unknown";

    // Find existing pool for this port
    const existingIdx = db.proxyPools.findIndex(p => p.name === `xray-${node.tag}` || p._portKey === portKey);

    if (existingIdx >= 0) {
      db.proxyPools[existingIdx] = {
        ...db.proxyPools[existingIdx],
        proxyUrl: poolUrl,
        noProxy: "localhost,127.0.0.1,.internal",
        type: "xray",
        isActive: true,
        strictProxy: false,
        testStatus,
        lastTestedAt: now,
        _portKey: portKey,
        updatedAt: now
      };
      updated.push({ port, tag: node.tag, ip: testResults[i]?.externalIP });
      state.portMap[port] = db.proxyPools[existingIdx].id;
      state.poolMap[db.proxyPools[existingIdx].id] = { port, name: node.tag, ip: testName };
    } else {
      const id = uuid();
      const pool = {
        id,
        name: `xray-${node.tag}`,
        proxyUrl: poolUrl,
        noProxy: "localhost,127.0.0.1,.internal",
        type: "xray",
        isActive: true,
        strictProxy: false,
        testStatus,
        lastTestedAt: now,
        lastError: null,
        _portKey: portKey,
        createdAt: now,
        updatedAt: now
      };
      db.proxyPools.push(pool);
      created.push({ port, tag: node.tag, ip: testName });
      state.portMap[port] = id;
      state.poolMap[id] = { port, name: node.tag, ip: testName };
    }
  }

  // Deactivate stale pools (not in current node set)
  for (const pool of db.proxyPools) {
    if (pool.type === "xray" && !portSet.has(pool._portKey)) {
      // Only deactivate if no connection is using it
      const inUse = db.providerConnections?.some(c => c.providerSpecificData?.proxyPoolId === pool.id);
      if (!inUse) {
        pool.isActive = false;
        deactivated.push(pool.name);
      }
    }
  }

  saveDB(db);
  return { created: created.length, updated: updated.length, deactivated: deactivated.length };
}

function assignUniquePools() {
  const db = loadDB();
  const connections = db.providerConnections || [];
  const activeConns = connections.filter(c => c.isActive);
  const allXrayPools = (db.proxyPools || []).filter(p => p.type === "xray" && p.isActive !== false);
  const healthyPools = allXrayPools.filter(p => p.testStatus === "active");

  if (allXrayPools.length === 0) {
    log("warn", "No active Xray pools to assign");
    return { assigned: 0, failed: activeConns.length, totalConns: activeConns.length, totalPools: 0 };
  }

  // Pass both sets: use allXrayPools for preserving existing assignments,
  // prefer healthy pools for new assignments
  return assignWithPools(allXrayPools, healthyPools, activeConns, db);
}

function assignWithPools(allPools, healthyPools, activeConns, db) {
  let assigned = 0;
  let failed = 0;
  const usedPoolIds = new Set();

  for (const conn of activeConns) {
    const existingPoolId = conn.providerSpecificData?.proxyPoolId;

    if (existingPoolId) {
      // Keep existing assignment as long as the pool is still active
      const stillActive = allPools.find(p => p.id === existingPoolId);
      if (stillActive) {
        usedPoolIds.add(existingPoolId);
        continue; // Keep it
      }
      // Pool is gone - clear and reassign
      delete conn.providerSpecificData.proxyPoolId;
    }

    // Assign a healthy pool (prefer unused, cycle if needed)
    const available = healthyPools.length > 0 ? healthyPools : allPools;
    let pool = available.find(p => !usedPoolIds.has(p.id));
    if (!pool) pool = available[assigned % available.length];

    if (pool) {
      conn.providerSpecificData = { ...(conn.providerSpecificData || {}), proxyPoolId: pool.id };
      usedPoolIds.add(pool.id);
      assigned++;
    } else {
      failed++;
    }
  }

  saveDB(db);
  const uniqueUsed = new Set(Object.values(state.poolMap || {}).map(p => p?.poolId)).size;
  return { assigned, failed: activeConns.length - (activeConns.filter(c => c.providerSpecificData?.proxyPoolId && allPools.find(p => p.id === c.providerSpecificData.proxyPoolId)).length), totalConns: activeConns.length, totalPools: healthyPools.length };
}

// ─── Main Cycle ─────────────────────────────────────────────────────────────

async function runCycle() {
  if (state.running) { log("warn", "Cycle already running, skipping"); return; }
  state.running = true;
  state.cycleCount++;

  log("info", `=== Cycle #${state.cycleCount} starting ===`);

  try {
    // Step 1: Fetch nodes
    const nodes = await fetchAllNodes();
    if (nodes.length === 0) { log("warn", "No nodes fetched, keeping existing config"); return; }

    // Step 2: Build and deploy Xray config
    const config = buildXrayConfig(nodes);
    writeXrayConfig(config);
    const xrayOk = await reloadXray();
    if (!xrayOk) { log("error", "Xray failed to start, aborting cycle"); return; }

    // Wait for Xray to settle
    await new Promise(r => setTimeout(r, 3000));

    // Step 3: Test all ports
    log("info", "Testing all proxy ports...");
    const testResults = [];
    for (let i = 0; i < nodes.length; i++) {
      const port = BASE_HTTP_PORT + i;
      const result = await testPort(port);
      testResults.push(result);
    }

    const healthy = testResults.filter(r => r.status === "active").length;
    const dead = testResults.filter(r => r.status === "error").length;
    const uniqueIPs = new Set(testResults.filter(r => r.externalIP).map(r => r.externalIP)).size;
    log("info", `Test results: ${healthy} healthy, ${dead} dead, ${uniqueIPs} unique IPs`);

    // Step 4: Sync proxy pools to 9router
    const syncResult = syncProxyPools(nodes, testResults);
    log("info", `DB sync: ${syncResult.created} created, ${syncResult.updated} updated, ${syncResult.deactivated} deactivated`);

    // Step 5: Assign unique IPs to connections
    const assignResult = assignUniquePools();
    log("info", `Assignment: ${assignResult.assigned} assigned, ${assignResult.failed} failed (${assignResult.totalConns} conns, ${assignResult.totalPools} pools)`);

    // Summary
    log("info", `=== Cycle #${state.cycleCount} complete ===`);
    log("info", `  Nodes: ${nodes.length} deployed`);
    log("info", `  Health: ${healthy}/${nodes.length} pools healthy, ${uniqueIPs} unique IPs`);
    log("info", `  DB: ${syncResult.created + syncResult.updated} pools synced`);
    log("info", `  Connections: ${assignResult.assigned}/${assignResult.totalConns} assigned`);

    state.deployedNodes = nodes;
  } catch (err) {
    log("error", `Cycle failed: ${err.message}`, err.stack);
  } finally {
    state.running = false;
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

function startScheduler() {
  log("info", "Starting V2Ray Rotation Daemon");
  log("info", `  Node refresh: every ${CYCLE_INTERVAL_MS / 60000}min`);
  log("info", `  Health check: every ${HEALTH_INTERVAL_MS / 60000}min`);
  log("info", `  DB: ${DB_PATH}`);
  log("info", `  Xray: ${XRAY_CONFIG}`);

  // Initial cycle
  runCycle();

  // Node refresh timer
  setInterval(() => { runCycle(); }, CYCLE_INTERVAL_MS);

  // Health check timer (test without full refresh)
  setInterval(async () => {
    log("info", "[Health check] Testing active pools...");
    const db = loadDB();
    const pools = (db.proxyPools || []).filter(p => p.type === "xray" && p.isActive !== false);
    let healthy = 0;
    
    for (const pool of pools) {
      const match = pool.proxyUrl.match(/:(\d+)$/);
      if (!match) continue;
      const port = parseInt(match[1]);
      const result = await testPort(port);
      
      const idx = db.proxyPools.findIndex(p => p.id === pool.id);
      if (idx >= 0) {
        db.proxyPools[idx].testStatus = result.status === "active" ? "active" : "error";
        db.proxyPools[idx].lastTestedAt = new Date().toISOString();
        if (result.status === "active") {
          db.proxyPools[idx].lastError = null;
          healthy++;
        } else {
          db.proxyPools[idx].lastError = result.error;
        }
      }
    }
    
    saveDB(db);
    log("info", `[Health check] ${healthy}/${pools.length} pools healthy`);
  }, HEALTH_INTERVAL_MS);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("run")) {
  // Single run
  runCycle().then(() => {
    log("info", "Single cycle complete");
    process.exit(0);
  });
} else if (args.includes("status")) {
  // Show status
  const db = loadDB();
  const pools = (db.proxyPools || []).filter(p => p.type === "xray");
  const conns = (db.providerConnections || []).filter(c => c.isActive);
  const assigned = conns.filter(c => c.providerSpecificData?.proxyPoolId);
  
  console.log("V2Ray Rotation Status");
  console.log(`  Xray pools: ${pools.length} (${pools.filter(p => p.isActive).length} active)`);
  console.log(`  Connections: ${conns.length} total, ${assigned.length} with proxy pool assigned`);
  console.log(`  Daemon running: ${state.running}`);
} else if (args.includes("test")) {
  // Test all active pools
  (async () => {
    const db = loadDB();
    const pools = (db.proxyPools || []).filter(p => p.type === "xray" && p.isActive !== false);
    for (const pool of pools) {
      const match = pool.proxyUrl.match(/:(\d+)$/);
      if (!match) continue;
      const port = parseInt(match[1]);
      const result = await testPort(port);
      console.log(`  Port ${port} (${pool.name}): ${result.status} ${result.externalIP ? `→ ${result.externalIP}` : result.error || ""} (${result.latency}ms)`);
    }
  })();
} else {
  // Daemon mode
  startScheduler();
  
  // Keep process alive
  process.on("SIGINT", () => { log("info", "Daemon stopping"); process.exit(0); });
  process.on("SIGTERM", () => { log("info", "Daemon stopping"); process.exit(0); });
}
