import { createServer, Server, Socket } from 'net';
import { existsSync, unlinkSync, chmodSync } from 'fs';
import { resolve as pathResolve } from 'path';
import type { IPCRequest, IPCResponse } from '../types/index.js';
import { AgentManager } from './agent-manager.js';
import { getIpcPath } from '../utils/paths.js';

const WORKER_NAME_REGEX = /^[a-z0-9_-]+$/;

/**
 * IPC server for CLI <-> daemon communication.
 * Uses Unix domain socket on macOS/Linux, named pipe on Windows.
 * Replaces SIGUSR1 and other signal-based IPC.
 */
export class IPCServer {
  private server: Server | null = null;
  private socketPath: string;
  private agentManager: AgentManager;

  constructor(agentManager: AgentManager, instanceId: string = 'default') {
    this.agentManager = agentManager;
    this.socketPath = getIpcPath(instanceId);
  }

  /**
   * Start listening for IPC connections.
   */
  async start(): Promise<void> {
    // Clean up stale socket
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => {
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk.toString();
          // Try to parse complete JSON messages
          try {
            const request: IPCRequest = JSON.parse(data);
            data = '';
            this.handleRequest(request, socket);
          } catch {
            // Incomplete JSON, wait for more data
          }
        });

        socket.on('error', () => {
          // Client disconnected
        });
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Race: process was killed after unlink but before bind completed.
          // Clean up the re-created socket and retry once.
          try { unlinkSync(this.socketPath); } catch { /* ignore */ }
          this.server!.listen(this.socketPath, () => {
            console.log(`[ipc] Listening on ${this.socketPath} (recovered from stale socket)`);
            resolve();
          });
        } else {
          reject(err);
        }
      });

      this.server.listen(this.socketPath, () => {
        if (process.platform !== 'win32') {
          try {
            chmodSync(this.socketPath, 0o600);
          } catch {
            /* Windows / no-op */
          }
        }
        console.log(`[ipc] Listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server.
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Clean up socket file
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Handle an incoming IPC request.
   */
  private handleRequest(request: IPCRequest, socket: Socket): void {
    // BUG-015: log every incoming IPC request with its source so we can
    // trace which CLI command triggered which daemon action. The source
    // field is populated by CLI clients (cortextos enable / disable / stop
    // / bus / etc.); older or untracked callers fall back to 'unknown'.
    const agentTag = request.agent ? ` ${request.agent}` : '';
    console.log(`[ipc] ${request.type}${agentTag} from ${request.source || 'unknown'}`);

    let response: IPCResponse;

    try {
      switch (request.type) {
        case 'status':
          response = {
            success: true,
            data: this.agentManager.getAllStatuses(),
          };
          break;

        case 'list-agents':
          response = {
            success: true,
            data: this.agentManager.getAgentNames(),
          };
          break;

        case 'start-agent':
          if (!request.agent) {
            response = { success: false, error: 'Agent name required' };
          } else {
            // Start is async, respond immediately
            this.agentManager.startAgent(
              request.agent,
              (request.data?.dir as string) || '',
            ).catch(err => console.error(`Failed to start ${request.agent}:`, err));
            response = { success: true, data: `Starting ${request.agent}` };
          }
          break;

        case 'stop-agent':
          if (!request.agent) {
            response = { success: false, error: 'Agent name required' };
          } else {
            this.agentManager.stopAgent(request.agent)
              .catch(err => console.error(`Failed to stop ${request.agent}:`, err));
            response = { success: true, data: `Stopping ${request.agent}` };
          }
          break;

        case 'restart-agent':
          if (!request.agent) {
            response = { success: false, error: 'Agent name required' };
          } else {
            this.agentManager.restartAgent(request.agent)
              .catch(err => console.error(`Failed to restart ${request.agent}:`, err));
            response = { success: true, data: `Restarting ${request.agent}` };
          }
          break;

        case 'wake':
          // Wake a specific agent's fast checker (replaces SIGUSR1)
          if (request.agent) {
            const checker = this.agentManager.getFastChecker(request.agent);
            if (checker) {
              checker.wake();
              response = { success: true, data: 'Woke fast checker' };
            } else {
              response = { success: false, error: `Agent ${request.agent} not found` };
            }
          } else {
            response = { success: false, error: 'Agent name required' };
          }
          break;

        case 'spawn-worker': {
          const d = request.data as { name?: string; dir?: string; prompt?: string; parent?: string; model?: string } | undefined;
          if (!d?.name || !d?.dir || !d?.prompt) {
            response = { success: false, error: 'spawn-worker requires: name, dir, prompt' };
          } else if (!WORKER_NAME_REGEX.test(d.name) || d.name.length > 64) {
            response = { success: false, error: 'Invalid worker name' };
          } else {
            const resolvedDir = pathResolve(d.dir);
            const ctxRoot = process.env.CTX_ROOT ? pathResolve(process.env.CTX_ROOT) : '';
            const cwd = pathResolve(process.cwd());
            const underCtxRoot = ctxRoot && (resolvedDir === ctxRoot || resolvedDir.startsWith(ctxRoot + '/'));
            const underCwd = resolvedDir === cwd || resolvedDir.startsWith(cwd + '/');
            if (!underCtxRoot && !underCwd) {
              response = { success: false, error: 'Invalid worker dir' };
            } else {
              this.agentManager.spawnWorker(d.name, resolvedDir, d.prompt, d.parent, d.model)
                .catch(err => console.error(`[ipc] spawn-worker failed:`, err));
              response = { success: true, data: `Spawning worker ${d.name}` };
            }
          }
          break;
        }

        case 'terminate-worker': {
          const workerName = request.data?.name as string | undefined;
          if (!workerName) {
            response = { success: false, error: 'terminate-worker requires: name' };
          } else {
            this.agentManager.terminateWorker(workerName)
              .catch(err => console.error(`[ipc] terminate-worker failed:`, err));
            response = { success: true, data: `Terminating worker ${workerName}` };
          }
          break;
        }

        case 'list-workers':
          response = { success: true, data: this.agentManager.listWorkers() };
          break;

        case 'inject-worker': {
          const injectName = request.data?.name as string | undefined;
          const injectText = request.data?.text as string | undefined;
          if (!injectName || !injectText) {
            response = { success: false, error: 'inject-worker requires: name, text' };
          } else {
            const ok = this.agentManager.injectWorker(injectName, injectText);
            response = ok
              ? { success: true, data: `Injected into worker ${injectName}` }
              : { success: false, error: `Worker ${injectName} not found or not running` };
          }
          break;
        }

        default:
          response = { success: false, error: `Unknown command: ${request.type}` };
      }
    } catch (err) {
      response = { success: false, error: String(err) };
    }

    try {
      socket.write(JSON.stringify(response));
      socket.end();
    } catch {
      // Client disconnected
    }
  }
}

/**
 * IPC client for sending commands to the daemon.
 * Used by CLI commands.
 */
export class IPCClient {
  private socketPath: string;

  constructor(instanceId: string = 'default') {
    this.socketPath = getIpcPath(instanceId);
  }

  /**
   * Send a command to the daemon and get the response.
   */
  async send(request: IPCRequest): Promise<IPCResponse> {
    const { createConnection } = require('net');

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

      socket.on('error', (err: Error) => {
        if ((err as any).code === 'ECONNREFUSED' || (err as any).code === 'ENOENT') {
          resolve({
            success: false,
            error: 'Daemon is not running. Start it with: cortextos start',
          });
        } else {
          reject(err);
        }
      });

      // Timeout after 5 seconds
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('IPC request timed out'));
      });
    });
  }

  /**
   * Check if the daemon is running.
   */
  async isDaemonRunning(): Promise<boolean> {
    try {
      const response = await this.send({ type: 'status' });
      return response.success;
    } catch {
      return false;
    }
  }
}
