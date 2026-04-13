/**
 * Network module index
 * Exports all proxy rotation, health, and fetching functionality
 */

export {
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
} from "./proxyRotation.js";

export {
  testProxyPool,
  checkAllProxies,
  startAutomatedHealthCheck,
  stopAutomatedHealthCheck,
  getHealthCheckStatus,
  getHealthyPools,
  getUniqueIPs
} from "./proxyHealth.js";

export {
  fetchFreshProxies,
  getFetcherStatus
} from "./proxyFetcher.js";

export {
  startProxyRotationScheduler,
  stopProxyRotationScheduler,
  runFullCycle,
  triggerManualCycle,
  getSchedulerStatus,
  DEFAULT_SETTINGS
} from "./rotationScheduler.js";

export {
  resolveConnectionProxyConfig,
  normalizeLegacyProxy
} from "./connectionProxy.js";
