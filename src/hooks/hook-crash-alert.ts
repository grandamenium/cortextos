
/**
 * SessionEnd hook - crash alert via Telegram.
 * Categorizes session end type and sends notification.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return;

  const ctxRoot = join(homedir(), '.cortextos', instanceId);
  const stateDir = join(ctxRoot, 'state', agentName);
  const logDir = join(ctxRoot, 'logs', agentName);

  // Ensure directories exist
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  // Determine end type from state markers
  let endType = 'crash';
  let reason = '';

  const markers = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    // BUG-036: distinguish intentional disable/stop from crashes so the user
    // does not get a false 🚨 CRASH alarm when they themselves shut the agent down.
    { file: '.user-disable', type: 'user-disable' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  for (const marker of markers) {
    const markerPath = join(stateDir, marker.file);
    if (existsSync(markerPath)) {
      endType = marker.type;
      try {
        reason = readFileSync(markerPath, 'utf-8').trim();
        unlinkSync(markerPath);
      } catch { /* ignore */ }
      break;
    }
  }

  // Track crash count
  const today = new Date().toISOString().split('T')[0];
  const countFile = join(stateDir, '.crash_count_today');
  let crashCount = 0;
  if (endType === 'crash') {
    try {
      const data = readFileSync(countFile, 'utf-8').trim();
      const [date, count] = data.split(':');
      crashCount = date === today ? parseInt(count, 10) + 1 : 1;
    } catch {
      crashCount = 1;
    }
    try {
      writeFileSync(countFile, `${today}:${crashCount}`, 'utf-8');
    } catch { /* ignore */ }
  }

  // Read last heartbeat for context
  let lastTask = '';
  try {
    const hb = JSON.parse(readFileSync(join(stateDir, 'heartbeat.json'), 'utf-8'));
    lastTask = hb.status || '';
  } catch { /* ignore */ }

  // Log to crashes.log
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} type=${endType} reason=${reason || 'none'} last_task=${lastTask}\n`;
  try {
    appendFileSync(join(logDir, 'crashes.log'), logLine);
  } catch { /* ignore */ }

  // Send Telegram alert
  const botToken = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;
  if (!botToken || !chatId) return;

  let message = '';
  switch (endType) {
    case 'planned-restart':
      message = `🔄 ${agentName} restarted (planned): ${reason || 'no reason given'}`;
      break;
    case 'session-refresh':
      message = `♻️ ${agentName} session refresh (context exhaustion). Restarting with fresh session.`;
      break;
    case 'user-restart':
      message = `🔄 ${agentName} restarted by user: ${reason || 'no reason given'}`;
      break;
    case 'user-disable':
      message = `⏸️ ${agentName} disabled by user.`;
      if (reason) message += ` (${reason})`;
      break;
    case 'user-stop':
      message = `⏹️ ${agentName} stopped by user.`;
      if (reason) message += ` (${reason})`;
      break;
    case 'crash':
      message = `🚨 CRASH: ${agentName} died unexpectedly.`;
      if (crashCount > 0) message += ` Crashes today: ${crashCount}.`;
      if (lastTask) message += `\nLast status: ${lastTask}`;
      break;
  }

  if (message) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
    } catch { /* ignore send failures */ }
  }
}

main().catch(() => process.exit(0));
