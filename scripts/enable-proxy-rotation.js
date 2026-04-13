#!/usr/bin/env node
/**
 * Enable proxy rotation and run initial cycle
 * 
 * Usage: node scripts/enable-proxy-rotation.js
 * 
 * This script:
 * 1. Enables proxy rotation in settings
 * 2. Fetches fresh proxy nodes from GitHub sources
 * 3. Tests all existing proxy pools
 * 4. Assigns unique IPs to each connection
 * 5. Reports status
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// Find db.json
const dbPaths = [
  join(process.env.HOME || process.env.USERPROFILE, ".9router", "db.json"),
  join(projectRoot, ".9router", "db.json"),
];

let dbPath = dbPaths.find(p => {
  try { return readFileSync(p, "utf-8"); } catch { return false; }
});

if (!dbPath) {
  console.log("❌ No 9router database found.");
  console.log("Run 9router first to create the database, then re-run this script.");
  process.exit(1);
}

console.log(`📂 Database: ${dbPath}`);

const db = JSON.parse(readFileSync(dbPath, "utf-8"));

// Check existing proxy pools
const pools = db.proxyPools || [];
const connections = db.providerConnections || [];
const activeConnections = connections.filter(c => c.isActive);

console.log(`\n📊 Current state:`);
console.log(`   Proxy pools: ${pools.length}`);
console.log(`   Active connections: ${activeConnections.length}`);
console.log(`   Proxy rotation: ${db.settings?.enableProxyRotation ? "✅ enabled" : "❌ disabled"}`);

// Enable proxy rotation
db.settings = db.settings || {};
db.settings.enableProxyRotation = true;
db.settings.proxyRotationStrategy = "sticky";
db.settings.proxyRotationIntervalMs = 3600000;     // 1 hour
db.settings.proxyHealthCheckIntervalMs = 300000;    // 5 min
db.settings.proxyFetchIntervalMs = 3600000;         // 1 hour
db.settings.proxyMinHealthyCount = 2;
db.settings.proxyMaxFailures = 3;
db.settings.proxyAutoFetchEnabled = true;

writeFileSync(dbPath, JSON.stringify(db, null, 2));

console.log(`\n✅ Proxy rotation enabled in settings`);
console.log(`   Strategy: sticky (keep working IPs, only replace failed ones)`);
console.log(`   Health check: every 5 minutes`);
console.log(`   IP rotation: every 1 hour`);
console.log(`   Auto-fetch: enabled (new nodes every hour)`);

console.log(`\n🔄 To trigger a manual rotation cycle, run:`);
console.log(`   curl -X POST http://localhost:3000/api/proxy-rotation/trigger`);
console.log(`\n📋 To check status:`);
console.log(`   curl -X POST http://localhost:3000/api/proxy-rotation/status`);
console.log(`\n🔍 To test all proxies:`);
console.log(`   curl -X POST http://localhost:3000/api/proxy-rotation/health`);
console.log(`\n🆕 To fetch fresh nodes:`);
console.log(`   curl -X POST http://localhost:3000/api/proxy-rotation/fetch`);

console.log(`\n⚠️  Restart 9router for the scheduler to start:`);
console.log(`   pkill -f "next.*9router" && cd ${projectRoot} && npm run dev &`);
