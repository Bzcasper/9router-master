#!/usr/bin/env node
/**
 * V2Ray Rotation Daemon v2 — 9Router Isolated
 * 
 * Fetches free v2ray/socks5/http nodes → routes through Xray HTTP proxies
 * Assigns ONE unique external IP per 9router connection.
 * 
 * ISOLATION: Only touches ~/.9router/db.json and /usr/local/etc/xray/config.json
 */

const { exec, execSync } = require("child_process");
const { readFileSync, writeFileSync } = require("fs");
const { join } = require("path");
const { createHash } = require("crypto");
const crypto = require("crypto");

// ─── Config ────────────────────────────────────────────────────────────────

const DB_PATH = join(process.env.HOME, ".9router", "db.json");
const XRAY_CONFIG = "/usr/local/etc/xray/config.json";
const BASE_HTTP_PORT = 10810;
const TEST_URL = "https://httpbin.org/ip";
const TEST_TIMEOUT = 8000;
const CYCLE_INTERVAL_MS = 3600000;      // 1 hour: full refresh
const HEALTH_INTERVAL_MS = 300000;       // 5 min: health check
const MAX_NODES_PER_SOURCE = 40;
const MAX_TOTAL_NODES = 80;              // Xray can handle 80+ nodes
const MIN_HEALTHY_NODES = 10;            // Below this, trigger emergency refresh
const EMERGENCY_REFRESH_MS = 300000;     // 5 min refresh when low

// All free proxy sources — v2ray/ss/trojan/vless
const SUBSCRIPTION_SOURCES = [
  { name: "Pawdroid", url: "https://raw.githubusercontent.com/Pawdroid/Free-servers/main/sub" },
  { name: "Ermaozi", url: "https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt" },
  { name: "Mfuu", url: "https://raw.githubusercontent.com/mfuu/v2ray/master/v2ray" },
  { name: "Aiboboxx", url: "https://raw.githubusercontent.com/aiboboxx/v2rayfree/main/v2" },
  { name: "NoMoreWalls", url: "https://raw.githubusercontent.com/peasoft/NoMoreWalls/master/list.txt" },
  { name: "Roozk", url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/V2RAY_RAW.txt" },
  { name: "Ts-sf", url: "https://raw.githubusercontent.com/ts-sf/fly/main/v2" },
  { name: "Peasoft2", url: "https://raw.githubusercontent.com/peasoft/NoMoreWalls/master/list.yml" },
];

let state = {
  deployedNodes: [],
  portMap: {},       // port → poolId
  poolMap: {},       // poolId → { port, name, ip }
  running: false,
  cycleCount: 0,
  lastHealthyCount: 0,
};

const log = (level, ...args) => {
  console.log(`[${new Date().toISOString()}][${level.toUpperCase()}]`, ...args);
};

// ─── DB Helpers (9router ONLY) ──────────────────────────────────────────────

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
      
      // Filter unsupported ciphers for Xray v26+
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
      node.tag = `${node.tag}-${createHash("md5").update(url).digest("hex").slice(0, 6)}`;
      allNodes.push(node);
      parsed++;
    }
    log("info", `  ${source.name}: ${parsed} nodes`);
  }

  // Shuffle for diversity (avoid same sources always on top)
  for (let i = allNodes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allNodes[i], allNodes[j]] = [allNodes[j], allNodes[i]];
  }

  log("info", `Total unique nodes: ${allNodes.length}`);
  const byProtocol = {};
  for (const n of allNodes) byProtocol[n.protocol] = (byProtocol[n.protocol] || 0) + 1;
  log("info", `  By protocol: ${JSON.stringify(byProtocol)}`);
  
  // Cap total
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

  // SOCKS inbound (general purpose)
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
  let created = 0, updated = 0, deactivated = 0;

  for (let i = 0; i < nodes.length; i++) {
    const port = BASE_HTTP_PORT + i;
    const node = nodes[i];
    const portKey = `port-${port}`;
    portSet.add(portKey);

    const poolUrl = `http://127.0.0.1:${port}`;
    const testStatus = testResults[i]?.status === "active" ? "active" : "error";
    const testName = testResults[i]?.externalIP || "unknown";

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
        lastError: testResults[i]?.status === "error" ? testResults[i]?.error : null,
        _lastIP: testResults[i]?.externalIP || db.proxyPools[existingIdx]._lastIP || "unknown",
        _portKey: portKey,
        updatedAt: now
      };
      updated++;
      state.portMap[port] = db.proxyPools[existingIdx].id;
      state.poolMap[db.proxyPools[existingIdx].id] = { port, name: node.tag, ip: db.proxyPools[existingIdx]._lastIP };
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
        _lastIP: testResults[i]?.externalIP || "unknown",
        _portKey: portKey,
        createdAt: now,
        updatedAt: now
      };
      db.proxyPools.push(pool);
      created++;
      state.portMap[port] = id;
      state.poolMap[id] = { port, name: node.tag, ip: pool._lastIP };
    }
  }

  // Deactivate stale pools not in current node set
  for (const pool of db.proxyPools) {
    if (pool.type === "xray" && !portSet.has(pool._portKey)) {
      const inUse = db.providerConnections?.some(c => c.providerSpecificData?.proxyPoolId === pool.id);
      if (!inUse) {
        pool.isActive = false;
        deactivated++;
      }
    }
  }

  saveDB(db);
  return { created, updated, deactivated };
}

// ─── Unique IP Assignment ───────────────────────────────────────────────────

function assignUniqueIPs() {
  const db = loadDB();
  const connections = db.providerConnections || [];
  const activeConns = connections.filter(c => c.isActive);
  const allXrayPools = (db.proxyPools || []).filter(p => p.type === "xray" && p.isActive !== false);
  // Only pools with known good IPs (tested and returned an IP)
  const knownIPPools = allXrayPools.filter(p => p._lastIP && p._lastIP !== "unknown");
  const healthyIPPools = knownIPPools.filter(p => p.testStatus === "active");

  if (knownIPPools.length === 0) {
    log("warn", "No pools with known IPs to assign");
    return { assigned: 0, failed: activeConns.length, totalConns: activeConns.length, totalPools: 0, uniqueIPs: 0 };
  }

  // First pass: validate existing assignments
  const ipDistribution = {};
  const usedPoolIds = new Set();
  let validExisting = 0;
  let staleAssigned = 0;

  for (const conn of activeConns) {
    const existingPoolId = conn.providerSpecificData?.proxyPoolId;
    if (existingPoolId) {
      const pool = allXrayPools.find(p => p.id === existingPoolId);
      if (pool && pool._lastIP && pool._lastIP !== "unknown") {
        usedPoolIds.add(existingPoolId);
        ipDistribution[pool._lastIP] = (ipDistribution[pool._lastIP] || 0) + 1;
        validExisting++;
      } else {
        // Stale/dead pool - clear and reassign
        delete conn.providerSpecificData.proxyPoolId;
        staleAssigned++;
      }
    }
  }

  // Second pass: assign unassigned connections from known-IP pools first
  let newAssigned = 0;
  for (const conn of activeConns) {
    if (conn.providerSpecificData?.proxyPoolId) continue;

    // Try healthy pools with known IPs first (best case: unique IP)
    const available = healthyIPPools.length > 0 ? healthyIPPools : knownIPPools;
    let pool = available.find(p => !usedPoolIds.has(p.id));
    
    // If no known-IP pool available, fall back to any active pool
    if (!pool && allXrayPools.length > 0) {
      pool = allXrayPools.find(p => !usedPoolIds.has(p.id));
    }
    
    if (!pool) pool = available[newAssigned % (available.length || 1)] || allXrayPools[newAssigned % allXrayPools.length];

    if (pool) {
      conn.providerSpecificData = { ...(conn.providerSpecificData || {}), proxyPoolId: pool.id };
      usedPoolIds.add(pool.id);
      const ip = (pool._lastIP && pool._lastIP !== "unknown") ? pool._lastIP : `unknown (${pool.name.slice(0, 20)})`;
      ipDistribution[ip] = (ipDistribution[ip] || 0) + 1;
      newAssigned++;
    }
  }

  saveDB(db);
  
  const totalAssigned = validExisting + newAssigned;
  const uniqueIPs = Object.keys(ipDistribution).filter(k => !k.startsWith("unknown")).length;
  
  return { 
    assigned: totalAssigned, 
    failed: activeConns.length - totalAssigned, 
    totalConns: activeConns.length, 
    totalPools: knownIPPools.length,
    uniqueIPs,
    ipDistribution
  };
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
    state.lastHealthyCount = healthy;

    // Step 4: Sync proxy pools to 9router
    const syncResult = syncProxyPools(nodes, testResults);
    log("info", `DB sync: ${syncResult.created} created, ${syncResult.updated} updated, ${syncResult.deactivated} deactivated`);

    // Step 5: Assign unique IPs to connections
    const assignResult = assignUniqueIPs();
    log("info", `Assignment: ${assignResult.assigned}/${assignResult.totalConns} connections routed through ${assignResult.uniqueIPs} unique IPs`);

    // Summary
    log("info", `=== Cycle #${state.cycleCount} complete ===`);
    log("info", `  Nodes: ${nodes.length} deployed`);
    log("info", `  Health: ${healthy}/${nodes.length} pools healthy`);
    log("info", `  Connections: ${assignResult.assigned}/${assignResult.totalConns} assigned to ${assignResult.uniqueIPs} unique IPs`);

    if (assignResult.ipDistribution) {
      log("info", "  IP distribution:");
      for (const [ip, count] of Object.entries(assignResult.ipDistribution).sort((a, b) => b[1] - a[1])) {
        log("info", `    ${ip}: ${count} connection(s)`);
      }
    }

    state.deployedNodes = nodes;
  } catch (err) {
    log("error", `Cycle failed: ${err.message}`, err.stack);
  } finally {
    state.running = false;
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

function startScheduler() {
  log("info", "=== V2Ray Rotation Daemon (9Router Isolated) ===");
  log("info", `  Node refresh: every ${CYCLE_INTERVAL_MS / 60000}min`);
  log("info", `  Health check: every ${HEALTH_INTERVAL_MS / 60000}min`);
  log("info", `  DB: ${DB_PATH}`);
  log("info", `  Xray: ${XRAY_CONFIG}`);
  log("info", `  Max nodes: ${MAX_TOTAL_NODES}`);

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
          db.proxyPools[idx]._lastIP = result.externalIP || db.proxyPools[idx]._lastIP;
          db.proxyPools[idx].lastError = null;
          healthy++;
        } else {
          db.proxyPools[idx].lastError = result.error;
        }
      }
    }
    
    saveDB(db);
    log("info", `[Health check] ${healthy}/${pools.length} pools healthy`);
    state.lastHealthyCount = healthy;

    // Emergency refresh if too few healthy
    if (healthy < MIN_HEALTHY_NODES && !state.running) {
      log("warn", `Only ${healthy} healthy pools (< ${MIN_HEALTHY_NODES}), triggering emergency refresh`);
      runCycle();
    }
  }, HEALTH_INTERVAL_MS);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("run")) {
  runCycle().then(() => {
    log("info", "Single cycle complete");
    process.exit(0);
  });
} else if (args.includes("status")) {
  const db = loadDB();
  const pools = (db.proxyPools || []).filter(p => p.type === "xray");
  const conns = (db.providerConnections || []).filter(c => c.isActive);
  const assigned = conns.filter(c => c.providerSpecificData?.proxyPoolId);
  const healthy = pools.filter(p => p.isActive && p.testStatus === "active");
  const uniqueIPs = new Set(healthy.map(p => p.proxyUrl.split(":").pop())).size;
  
  console.log("=== V2Ray Rotation Status (9Router Isolated) ===");
  console.log(`  Xray pools: ${pools.length} (${pools.filter(p => p.isActive).length} active, ${healthy.length} healthy)`);
  console.log(`  Unique IPs: ${uniqueIPs}`);
  console.log(`  Connections: ${conns.length} total, ${assigned.length} with proxy pool assigned`);
  console.log(`  Daemon cycles: ${state.cycleCount}, last healthy: ${state.lastHealthyCount}`);
  console.log(`  Sources: ${SUBSCRIPTION_SOURCES.length}, max nodes: ${MAX_TOTAL_NODES}`);
} else if (args.includes("test")) {
  (async () => {
    const db = loadDB();
    const pools = (db.proxyPools || []).filter(p => p.type === "xray" && p.isActive !== false);
    for (const pool of pools) {
      const match = pool.proxyUrl.match(/:(\d+)$/);
      if (!match) continue;
      const port = parseInt(match[1]);
      const result = await testPort(port);
      const ip = result.externalIP || result.error || "";
      console.log(`  Port ${port} (${pool.name}): ${result.status} → ${ip} (${result.latency}ms)`);
    }
  })();
} else {
  // Daemon mode
  startScheduler();
  
  process.on("SIGINT", () => { log("info", "Daemon stopping"); process.exit(0); });
  process.on("SIGTERM", () => { log("info", "Daemon stopping"); process.exit(0); });
}
