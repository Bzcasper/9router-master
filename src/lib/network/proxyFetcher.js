/**
 * Proxy Fetcher
 * 
 * Fetches fresh proxy nodes from public GitHub sources,
 * parses them, tests them, and creates new proxy pool entries.
 */

import { createProxyPool, getProxyPools } from "../models/index.js";
import { testProxyPool } from "./proxyHealth.js";

// Curated list of reliable free proxy sources
const PROXY_SOURCES = [
  {
    name: "Pawdroid",
    url: "https://raw.githubusercontent.com/Pawdroid/Free-servers/main/sub",
    type: "base64-mixed"
  },
  {
    name: "Ermaozi",
    url: "https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt",
    type: "base64-mixed"
  },
  {
    name: "Mfuu",
    url: "https://raw.githubusercontent.com/mfuu/v2ray/master/v2ray",
    type: "base64-mixed"
  },
  {
    name: "Aiboboxx",
    url: "https://raw.githubusercontent.com/aiboboxx/v2rayfree/main/v2",
    type: "base64-mixed"
  },
  {
    name: "NoMoreWalls",
    url: "https://raw.githubusercontent.com/peasoft/NoMoreWalls/master/list.txt",
    type: "base64-mixed"
  }
];

const FETCH_TIMEOUT_MS = 10000;
const MAX_NODES_PER_SOURCE = 50;
const TEST_CONCURRENCY = 3;

const log = (level, ...args) => {
  console.log(`[ProxyFetcher][${level.toUpperCase()}]`, ...args);
};

/**
 * Fetch raw subscription from a URL
 * @param {string} url 
 * @returns {string|null} Decoded text content
 */
async function fetchSubscription(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const text = await response.text();
    
    // Try to decode as base64 (most subscriptions are base64 encoded)
    try {
      const decoded = Buffer.from(text.trim(), "base64").toString("utf-8");
      // Check if it looks like decoded content (has :// in it)
      if (decoded.includes("://")) {
        return decoded;
      }
    } catch {
      // Not base64, return raw
    }
    
    return text;
  } catch (err) {
    log("warn", `Failed to fetch ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Parse subscription text into individual proxy URLs
 * @param {string} text 
 * @param {string} type 
 * @returns {string[]} Array of proxy URLs
 */
function parseSubscription(text, type) {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  
  if (type === "base64-mixed") {
    // Each line might be a base64-encoded individual URL
    const urls = [];
    for (const line of lines) {
      if (line.startsWith("vmess://") || line.startsWith("vless://") || 
          line.startsWith("trojan://") || line.startsWith("ss://")) {
        urls.push(line);
      } else {
        // Try to decode
        try {
          const decoded = Buffer.from(line, "base64").toString("utf-8");
          if (decoded.includes("://")) {
            urls.push(decoded);
          }
        } catch {
          // Skip invalid
        }
      }
    }
    return urls;
  }

  // Raw format: one URL per line
  return lines.filter(l => l.startsWith("vmess://") || l.startsWith("vless://") || 
                          l.startsWith("trojan://") || l.startsWith("ss://") || 
                          l.startsWith("http://") || l.startsWith("https://"));
}

/**
 * Convert a v2ray proxy URL to an HTTP proxy pool entry
 * Only extracts usable HTTP/SOCKS proxies.
 * VLESS/VMess nodes need Xray to work - we convert them to http://127.0.0.1:PORT format
 * if they're running through local Xray, otherwise skip.
 * 
 * For direct HTTP/SOCKS proxies, convert to pool format.
 */
function urlToPoolEntry(url, index) {
  // Direct HTTP proxy
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const urlObj = new URL(url);
      return {
        name: `Fetched-${urlObj.hostname}`,
        proxyUrl: url,
        noProxy: "localhost,127.0.0.1,.internal",
        type: "http",
        isActive: true,
        strictProxy: false
      };
    } catch {
      return null;
    }
  }

  // For v2ray protocols (vmess, vless, trojan, ss), we can't use them directly as HTTP proxies.
  // They require Xray to decode. Skip for now - the Xray setup handles these separately.
  return null;
}

/**
 * Fetch nodes from all sources
 * @param {Object} options
 * @param {number} options.maxPerSource - Max nodes to test per source
 * @param {boolean} options.testNodes - Test nodes before adding
 * @returns {Object} { fetched: number, tested: number, added: number, pools: [] }
 */
export async function fetchFreshProxies(options = {}) {
  const maxPerSource = options.maxPerSource ?? MAX_NODES_PER_SOURCE;
  const testNodes = options.testNodes !== false;

  log("info", `Fetching from ${PROXY_SOURCES.length} sources (max ${maxPerSource} per source)`);

  const allUrls = new Set();
  const sourceStats = [];

  // Fetch from all sources
  for (const source of PROXY_SOURCES) {
    log("debug", `Fetching ${source.name}...`);
    
    const text = await fetchSubscription(source.url);
    if (!text) {
      sourceStats.push({ name: source.name, urls: 0, status: "failed" });
      continue;
    }

    const urls = parseSubscription(text, source.type);
    const count = Math.min(urls.length, maxPerSource);
    const sampled = urls.slice(0, count);
    
    for (const url of sampled) {
      allUrls.add(url);
    }

    sourceStats.push({ name: source.name, urls: count, status: "ok" });
    log("debug", `  ${source.name}: ${count} URLs`);
  }

  log("info", `Total unique URLs: ${allUrls.size}`);

  // Convert to pool entries (only HTTP/SOCKS proxies)
  const poolEntries = [];
  let directProxyIndex = 0;

  for (const url of allUrls) {
    const entry = urlToPoolEntry(url, directProxyIndex);
    if (entry) {
      poolEntries.push(entry);
      directProxyIndex++;
    }
  }

  log("info", `Converted ${poolEntries.length} direct HTTP/SOCKS proxies from ${allUrls.size} total URLs`);
  log("info", `Remaining ${allUrls.size - poolEntries.length} v2ray nodes need Xray integration (handled separately)`);

  // Test and add pools
  const results = {
    fetched: allUrls.size,
    tested: 0,
    added: 0,
    pools: [],
    sourceStats
  };

  if (testNodes && poolEntries.length > 0) {
    log("info", `Testing ${poolEntries.length} proxy entries...`);

    const existingPools = await getProxyPools();
    const existingUrls = new Set(existingPools.map(p => p.proxyUrl));

    // Test in batches
    for (let i = 0; i < poolEntries.length; i += TEST_CONCURRENCY) {
      const batch = poolEntries.slice(i, i + TEST_CONCURRENCY);
      
      const testResults = await Promise.all(
        batch.map(async (entry) => {
          // Skip if already exists
          if (existingUrls.has(entry.proxyUrl)) {
            return { entry, status: "duplicate", testResult: null };
          }

          // Create temp pool object for testing
          const tempPool = { ...entry, id: `temp-${Date.now()}` };
          const testResult = await testProxyPool(tempPool);
          return { entry, status: testResult.status, testResult };
        })
      );

      for (const { entry, status, testResult } of testResults) {
        results.tested++;

        if (status === "active") {
          // Add to database
          try {
            const pool = await createProxyPool(entry);
            results.added++;
            results.pools.push({
              id: pool.id,
              name: entry.name,
              proxyUrl: entry.proxyUrl,
              externalIP: testResult.externalIP,
              latency: testResult.latency
            });
            log("debug", `  Added: ${entry.name} → ${entry.proxyUrl} (${testResult.latency}ms)`);
          } catch (err) {
            log("error", `Failed to create pool: ${err.message}`);
          }
        }
      }
    }
  } else if (poolEntries.length > 0) {
    // Add without testing
    log("info", `Adding ${poolEntries.length} proxies without testing`);
    
    const existingPools = await getProxyPools();
    const existingUrls = new Set(existingPools.map(p => p.proxyUrl));

    for (const entry of poolEntries) {
      if (!existingUrls.has(entry.proxyUrl)) {
        try {
          const pool = await createProxyPool(entry);
          results.added++;
          results.pools.push({ id: pool.id, name: entry.name, proxyUrl: entry.proxyUrl });
        } catch (err) {
          log("error", `Failed to create pool: ${err.message}`);
        }
      }
    }
  }

  log("info", `Fetch complete: ${results.fetched} fetched, ${results.tested} tested, ${results.added} added`);

  return results;
}

/**
 * Get proxy fetcher status
 */
export function getFetcherStatus() {
  return {
    sources: PROXY_SOURCES.length,
    maxPerSource: MAX_NODES_PER_SOURCE,
    concurrency: TEST_CONCURRENCY
  };
}

export default {
  fetchFreshProxies,
  getFetcherStatus
};
