/**
 * POST /api/v2ray-rotation/status - Get full status
 * POST /api/v2ray-rotation/trigger - Trigger manual cycle
 * POST /api/v2ray-rotation/config - Update rotation settings
 * POST /api/v2ray-rotation/fetch - Fetch and deploy fresh nodes
 * POST /api/v2ray-rotation/test - Test all proxy pools
 * POST /api/v2ray-rotation/assign - Assign unique IPs to connections
 */

import { NextResponse } from "next/server";
import {
  getV2RaySchedulerStatus,
  triggerManualCycle,
  startV2RayRotation,
  stopV2RayRotation
} from "../../lib/v2ray/v2rayRotationScheduler.js";
import { refreshBridge, testAllPools, assignUniquePools, getBridgeStatus } from "../../lib/v2ray/xrayBridge.js";
import { fetchAllNodes } from "../../lib/v2ray/v2rayNodeManager.js";
import { getSettings, updateSettings } from "../../lib/models/index.js";

export async function POST(request) {
  const url = new URL(request.url);
  const action = url.pathname.split("/").pop();

  try {
    switch (action) {
      case "status":
        return NextResponse.json({
          success: true,
          data: {
            scheduler: getV2RaySchedulerStatus(),
            bridge: getBridgeStatus()
          }
        });

      case "trigger": {
        const result = await triggerManualCycle();
        return NextResponse.json({ success: true, data: result });
      }

      case "config": {
        const body = await request.json();
        const settings = await getSettings();
        const updates = {};

        if (body.v2rayRotationEnabled !== undefined) updates.v2rayRotationEnabled = body.v2rayRotationEnabled;
        if (body.v2rayRefreshIntervalMs !== undefined) updates.v2rayRefreshIntervalMs = body.v2rayRefreshIntervalMs;
        if (body.v2rayTestIntervalMs !== undefined) updates.v2rayTestIntervalMs = body.v2rayTestIntervalMs;
        if (body.v2rayAssignIntervalMs !== undefined) updates.v2rayAssignIntervalMs = body.v2rayAssignIntervalMs;
        if (body.v2rayMaxPerSource !== undefined) updates.v2rayMaxPerSource = body.v2rayMaxPerSource;
        if (body.v2rayMinNodes !== undefined) updates.v2rayMinNodes = body.v2rayMinNodes;

        if (Object.keys(updates).length > 0) {
          await updateSettings(updates);
        }

        return NextResponse.json({ success: true, data: { ...settings, ...updates } });
      }

      case "fetch": {
        const body = await request.json().catch(() => ({}));
        const { nodes, stats } = await fetchAllNodes({
          maxPerSource: body.maxPerSource || 60,
          deduplicate: true
        });
        return NextResponse.json({ success: true, data: { nodes: nodes.length, stats, sample: nodes.slice(0, 5) } });
      }

      case "refresh": {
        const result = await refreshBridge();
        return NextResponse.json({ success: result.success, data: result });
      }

      case "test": {
        const results = await testAllPools();
        return NextResponse.json({ success: true, data: results });
      }

      case "assign": {
        const result = await assignUniquePools();
        return NextResponse.json({ success: true, data: result });
      }

      case "start": {
        await startV2RayRotation();
        return NextResponse.json({ success: true, message: "V2Ray rotation started" });
      }

      case "stop": {
        stopV2RayRotation();
        return NextResponse.json({ success: true, message: "V2Ray rotation stopped" });
      }

      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error("[V2RayRotation API] Error:", err);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
