import { createConnection } from 'net';
import { homedir } from 'os';
import { join } from 'path';

export type ExecutionLogStatusFilter = 'all' | 'success' | 'failure';

// ---------------------------------------------------------------------------
// Fleet Health types (Subtask 4.4)
// ---------------------------------------------------------------------------

export type CronHealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

export interface CronHealthRow {
  agent: string;
  org: string;
  cronName: string;
  state: CronHealthState;
  reason: string;
  lastFire: number | null;
  expectedIntervalMs: number;
  gapMs: number | null;
  successRate24h: number;
  firesLast24h: number;
  nextFire: string;
}

export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

export interface FleetHealthResponse {
  rows: CronHealthRow[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

export interface CronExecutionLogEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

/** Paginated response for list-cron-executions IPC command (Subtask 4.3). */
export interface CronExecutionLogPage {
  entries: CronExecutionLogEntry[];
  total: number;
  hasMore: boolean;
}

export interface IPCRequest {
  type:
    | 'status'
    | 'start-agent'
    | 'stop-agent'
    | 'restart-agent'
    | 'wake'
    | 'list-agents'
    | 'list-all-crons'
    | 'list-cron-executions'
    | 'reload-crons'
    | 'fire-cron'
    | 'inject-agent'
    | 'add-cron'
    | 'update-cron'
    | 'remove-cron'
    | 'fleet-health';
  agent?: string;
  data?: Record<string, unknown>;
}

export interface IPCResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

function getIpcPath(instanceId: string = 'default'): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return join(homedir(), '.cortextos', instanceId, 'daemon.sock');
}

export class IPCClient {
  private socketPath: string;

  constructor(instanceId: string = 'default') {
    this.socketPath = getIpcPath(instanceId);
  }

  async send(request: IPCRequest): Promise<IPCResponse> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath, () => {
        socket.write(JSON.stringify(request));
      });

      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      socket.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid response from daemon'));
        }
      });

      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
          resolve({
            success: false,
            error: 'Daemon is not running. Start it with: cortextos start',
          });
        } else {
          reject(err);
        }
      });

      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('IPC request timed out'));
      });
    });
  }

  async isDaemonRunning(): Promise<boolean> {
    try {
      const response = await this.send({ type: 'status' });
      return response.success;
    } catch {
      return false;
    }
  }
}
