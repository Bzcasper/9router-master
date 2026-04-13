/**
 * POST /api/proxy-rotation/status - Get rotation system status
 * POST /api/proxy-rotation/trigger - Trigger manual rotation cycle
 * POST /api/proxy-rotation/config - Update rotation configuration
 * POST /api/proxy-rotation/fetch - Fetch fresh proxy nodes
 * POST /api/proxy-rotation/rotate - Force IP reassignment
 */

import { NextResponse } from "next/server";
import { getSchedulerStatus, triggerManualCycle } from "../../lib/network/rotationScheduler.js";
import { fetchFreshProxies } from "../../lib/network/proxyFetcher.js";
import { forceRotate, getRotationState, updateRotationConfig } from "../../lib/network/proxyRotation.js";
import { getHealthCheckStatus, checkAllProxies } from "../../lib/network/proxyHealth.js";
import { getSettings, updateSettings } from "../../lib/models/index.js";

export async function POST(request) {
  const url = new URL(request.url);
  const action = url.pathname.split("/").pop();

  try {
    switch (action) {
      case "status":
        return NextResponse.json({ success: true, data: getSchedulerStatus() });

      case "trigger": {
        const result = await triggerManualCycle();
        return NextResponse.json({ success: true, data: result });
      }

      case "config": {
        const body = await request.json();
        
        // Update settings in database
        const settings = await getSettings();
        const updates = {};
        
        if (body.enableProxyRotation !== undefined) updates.enableProxyRotation = body.enableProxyRotation;
        if (body.proxyRotationStrategy !== undefined) updates.proxyRotationStrategy = body.proxyRotationStrategy;
        if (body.proxyRotationIntervalMs !== undefined) updates.proxyRotationIntervalMs = body.proxyRotationIntervalMs;
        if (body.proxyHealthCheckIntervalMs !== undefined) updates.proxyHealthCheckIntervalMs = body.proxyHealthCheckIntervalMs;
        if (body.proxyFetchIntervalMs !== undefined) updates.proxyFetchIntervalMs = body.proxyFetchIntervalMs;
        if (body.proxyMinHealthyCount !== undefined) updates.proxyMinHealthyCount = body.proxyMinHealthyCount;
        if (body.proxyMaxFailures !== undefined) updates.proxyMaxFailures = body.proxyMaxFailures;
        if (body.proxyAutoFetchEnabled !== undefined) updates.proxyAutoFetchEnabled = body.proxyAutoFetchEnabled;
        
        if (Object.keys(updates).length > 0) {
          await updateSettings(updates);
          
          // Update in-memory config
          updateRotationConfig({
            enabled: updates.enableProxyRotation,
            strategy: updates.proxyRotationStrategy,
            rotationIntervalMs: updates.proxyRotationIntervalMs,
            minHealthyProxies: updates.proxyMinHealthyCount,
            maxFailures: updates.proxyMaxFailures
          });
        }

        return NextResponse.json({ success: true, data: { ...settings, ...updates } });
      }

      case "fetch": {
        const body = await request.json().catch(() => ({}));
        const result = await fetchFreshProxies({
          testNodes: body.testNodes !== false,
          maxPerSource: body.maxPerSource || 50
        });
        return NextResponse.json({ success: true, data: result });
      }

      case "rotate": {
        const result = await forceRotate();
        return NextResponse.json({ success: true, data: result });
      }

      case "health": {
        const body = await request.json().catch(() => ({}));
        const results = await checkAllProxies({ testAll: body.testAll });
        return NextResponse.json({ success: true, data: results });
      }

      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error("[ProxyRotation API] Error:", err);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
