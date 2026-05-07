import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';

type TerminalSession = {
  process: ChildProcessWithoutNullStreams;
  listeners: Set<(chunk: string) => void>;
};

const sessions = new Map<string, TerminalSession>();

export function createTerminalSession(cwd: string): string {
  const id = randomUUID();
  const child = spawn(process.env.SHELL || 'bash', ['-l'], {
    cwd,
    env: process.env,
    stdio: 'pipe',
  });
  const session: TerminalSession = { process: child, listeners: new Set() };
  sessions.set(id, session);

  const emit = (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    for (const listener of session.listeners) listener(text);
  };
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  child.on('exit', (code) => {
    for (const listener of session.listeners) listener(`\r\n[process exited ${code ?? ''}]\r\n`);
    sessions.delete(id);
  });

  return id;
}

export function writeTerminalSession(id: string, data: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.process.stdin.write(data);
  return true;
}

export function closeTerminalSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.process.kill();
  sessions.delete(id);
  return true;
}

export function subscribeTerminalSession(id: string, listener: (chunk: string) => void): () => void {
  const session = sessions.get(id);
  if (!session) throw new Error('session not found');
  session.listeners.add(listener);
  return () => {
    session.listeners.delete(listener);
  };
}
