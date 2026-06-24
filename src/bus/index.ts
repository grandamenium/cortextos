// Bus Module - Public API
// All bus functions for agent-to-agent messaging, tasks, events, heartbeats, approvals

export { sendMessage, checkInbox, ackInbox } from './message.js';
export { createTask, updateTask, completeTask, cancelTask, listTasks } from './task.js';
export { logEvent } from './event.js';
export { updateHeartbeat, readAllHeartbeats } from './heartbeat.js';
export { createApproval, updateApproval, listPendingApprovals } from './approval.js';
export {
  selfRestart,
  autoCommit,
  checkGoalStaleness,
  postActivity,
  type AutoCommitReport,
  type AgentGoalStatus,
  type GoalStalenessReport,
} from './system.js';
export {
  createExperiment,
  runExperiment,
  evaluateExperiment,
  listExperiments,
  gatherContext,
  manageCycle,
  type Experiment,
  type ExperimentCreateOptions,
  type ExperimentEvaluateOptions,
  type ExperimentFilters,
  type GatherContextOptions,
  type ExperimentContext,
  type ExperimentCycle,
  type ExperimentConfig,
} from './experiment.js';
export {
  browseCatalog,
  installCommunityItem,
  prepareSubmission,
  submitCommunityItem,
  type CatalogItem,
  type CatalogBrowseResult,
  type CatalogBrowseOptions,
  type InstallResult,
  type PrepareResult,
  type SubmitResult,
} from './catalog.js';
export {
  collectMetrics,
  parseUsageOutput,
  storeUsageData,
  checkUpstream,
  collectTelegramCommands,
  registerTelegramCommands,
  type MetricsReport,
  type AgentMetrics,
  type SystemMetrics,
  type UsageData,
  type UpstreamResult,
  type RegisterCommandsResult,
} from './metrics.js';
