/**
 * Xray Config Builder
 * 
 * Takes a list of live v2ray nodes and generates a complete Xray config.json
 * with one HTTP inbound port per node, routed via inboundTag→outboundTag.
 * 
 * Port range: 10810 - 10809 + N (configurable)
 * Each port becomes an HTTP proxy that 9router can connect to.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const XRAY_CONFIG_PATH = "/usr/local/etc/xray/config.json";
const BASE_HTTP_PORT = 10810;
const SOCKS_PORT = 10808;

const log = (level, ...args) => {
  console.log(`[XrayConfigBuilder][${level.toUpperCase()}]`, ...args);
};

/**
 * Build a complete Xray config from node list
 * 
 * @param {Array} nodes - Array of parsed v2ray node configs
 * @param {Object} options
 * @param {number} options.basePort - Starting HTTP port (default: 10810)
 * @param {boolean} options.includeSocks - Include SOCKS inbound (default: true)
 * @returns {Object} Complete Xray config
 */
export function buildXrayConfig(nodes, options = {}) {
  const basePort = options.basePort ?? BASE_HTTP_PORT;
  const includeSocks = options.includeSocks !== false;

  const inbounds = [];
  const outbounds = [];
  const routingRules = [];

  // SOCKS inbound (general purpose)
  if (includeSocks) {
    inbounds.push({
      port: SOCKS_PORT,
      listen: "127.0.0.1",
      protocol: "socks",
      settings: { auth: "noauth", udp: true },
      tag: "socks-in"
    });
    routingRules.push({
      type: "field",
      inboundTag: ["socks-in"],
      outboundTag: nodes.length > 0 ? nodes[0].tag : "direct"
    });
  }

  // HTTP inbounds + outbounds (one per node)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const port = basePort + i;
    const httpTag = `http-${port}`;
    const outboundTag = node.tag || `node-${i}`;

    // Inbound
    inbounds.push({
      port,
      listen: "127.0.0.1",
      protocol: "http",
      settings: {},
      tag: httpTag
    });

    // Outbound (copy node config with correct tag)
    outbounds.push({
      ...node,
      tag: outboundTag
    });

    // Routing rule
    routingRules.push({
      type: "field",
      inboundTag: [httpTag],
      outboundTag: outboundTag
    });
  }

  // Direct (fallback)
  outbounds.push({
    protocol: "freedom",
    tag: "direct",
    settings: {}
  });

  // Block
  outbounds.push({
    protocol: "blackhole",
    tag: "block",
    settings: {}
  });

  // Final catch-all route (direct)
  routingRules.push({
    type: "field",
    ip: ["geoip:private"],
    outboundTag: "direct"
  });

  const config = {
    log: { loglevel: "warning" },
    inbounds,
    outbounds,
    routing: {
      domainStrategy: "IPIfNonMatch",
      rules: routingRules
    }
  };

  return config;
}

/**
 * Validate an Xray config structure
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config.inbounds || !Array.isArray(config.inbounds)) {
    errors.push("Missing or invalid 'inbounds' array");
    return { valid: false, errors, warnings };
  }

  if (!config.outbounds || !Array.isArray(config.outbounds)) {
    errors.push("Missing or invalid 'outbounds' array");
    return { valid: false, errors, warnings };
  }

  // Check for duplicate inbound tags
  const inboundTags = config.inbounds.map(ib => ib.tag);
  const dupInbound = findDuplicates(inboundTags);
  if (dupInbound.length > 0) errors.push(`Duplicate inbound tags: ${dupInbound.join(", ")}`);

  // Check for duplicate outbound tags
  const outboundTags = config.outbounds.map(ob => ob.tag);
  const dupOutbound = findDuplicates(outboundTags);
  if (dupOutbound.length > 0) errors.push(`Duplicate outbound tags: ${dupOutbound.join(", ")}`);

  // Check routing rules reference valid tags
  if (config.routing && config.routing.rules) {
    for (const rule of config.routing.rules) {
      if (rule.outboundTag && !outboundTags.includes(rule.outboundTag)) {
        errors.push(`Rule references non-existent outbound: ${rule.outboundTag}`);
      }
      if (rule.inboundTag) {
        for (const tag of rule.inboundTag) {
          if (!inboundTags.includes(tag)) {
            errors.push(`Rule references non-existent inbound: ${tag}`);
          }
        }
      }
    }
  }

  // Check port conflicts
  const ports = config.inbounds.map(ib => ib.port);
  const dupPorts = findDuplicates(ports);
  if (dupPorts.length > 0) warnings.push(`Duplicate ports: ${dupPorts.join(", ")}`);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      inbounds: config.inbounds.length,
      outbounds: config.outbounds.length,
      rules: config.routing?.rules?.length || 0,
      httpPorts: config.inbounds.filter(ib => ib.protocol === "http").length
    }
  };
}

/**
 * Load existing config and merge new nodes
 * Preserves any custom settings not managed by this builder
 */
export function mergeIntoExistingConfig(newConfig) {
  let existing = null;
  
  try {
    if (existsSync(XRAY_CONFIG_PATH)) {
      existing = JSON.parse(readFileSync(XRAY_CONFIG_PATH, "utf-8"));
    }
  } catch (err) {
    log("warn", `Could not read existing config: ${err.message}`);
  }

  // Preserve log settings from existing
  if (existing?.log) {
    newConfig.log = { ...existing.log, ...newConfig.log };
  }

  return newConfig;
}

/**
 * Write config to Xray config path
 */
export function writeConfig(config, path = XRAY_CONFIG_PATH) {
  writeFileSync(path, JSON.stringify(config, null, 2));
  log("info", `Config written to ${path}`);
  log("info", `  ${config.inbounds.length} inbounds, ${config.outbounds.length} outbounds`);
}

/**
 * Reload Xray without downtime
 * Uses xray reload signal or restart
 */
export async function reloadXray() {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    // Try systemd reload first
    await execAsync("sudo systemctl reload xray 2>/dev/null || sudo systemctl restart xray");
    log("info", "Xray reloaded successfully");
    return { success: true };
  } catch (err) {
    // Fallback: direct restart
    try {
      await execAsync("sudo systemctl restart xray");
      log("info", "Xray restarted successfully");
      return { success: true };
    } catch (err2) {
      log("error", `Xray reload failed: ${err2.message}`);
      return { success: false, error: err2.message };
    }
  }
}

/**
 * Build, validate, write, and reload Xray config in one step
 */
export async function deployNodes(nodes, options = {}) {
  log("info", `Deploying ${nodes.length} nodes to Xray...`);

  const config = buildXrayConfig(nodes, options);
  const validation = validateConfig(config);

  if (!validation.valid) {
    log("error", `Config validation failed:`, validation.errors);
    return { success: false, errors: validation.errors };
  }

  if (validation.warnings.length > 0) {
    log("warn", `Config warnings:`, validation.warnings);
  }

  mergeIntoExistingConfig(config);
  writeConfig(config);

  const reloadResult = await reloadXray();

  return {
    success: reloadResult.success,
    deployed: nodes.length,
    ports: config.inbounds
      .filter(ib => ib.protocol === "http")
      .map(ib => ({ port: ib.port, tag: ib.tag, outbound: ib.tag.replace("http-", "") })),
    validation: {
      warnings: validation.warnings
    },
    reload: reloadResult
  };
}

/**
 * Get current Xray config
 */
export function getCurrentConfig() {
  try {
    if (!existsSync(XRAY_CONFIG_PATH)) return null;
    return JSON.parse(readFileSync(XRAY_CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Find duplicates in array
 */
function findDuplicates(arr) {
  const seen = new Set();
  const dups = new Set();
  for (const item of arr) {
    if (seen.has(item)) dups.add(item);
    seen.add(item);
  }
  return Array.from(dups);
}

export default {
  buildXrayConfig,
  validateConfig,
  writeConfig,
  reloadXray,
  deployNodes,
  getCurrentConfig,
  BASE_HTTP_PORT,
  SOCKS_PORT,
  XRAY_CONFIG_PATH
};
