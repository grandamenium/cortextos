/**
 * spawn-jules — dispatch a task to Jules (Google's AI coding agent) via the
 * Julius API and poll until the session reaches a terminal state.
 *
 * Jules operates as a remote HTTP session rather than a local child process,
 * so unlike spawn-codex there is no stdout/stderr to capture — the primary
 * artifact is the PR that Jules opens on completion.
 */

const JULES_API_BASE = "https://julius.googleapis.com/v1alpha";

export interface SpawnJulesOptions {
  /** GitHub repo slug, e.g. "RevOps-Global-GIT/rgos" */
  repo: string;
  /** Base branch Jules should work against (default: "main") */
  branch?: string;
  /** Task description sent as the session prompt */
  title: string;
  /** How often to poll the session state, in ms (default: 15000) */
  pollIntervalMs?: number;
  /** Maximum wait time before giving up, in ms (default: 600000 = 10 min) */
  timeoutMs?: number;
  /** Agent name for log context */
  agentName?: string;
  /** Task ID for log context */
  taskId?: string;
  /** Requester identity for log context */
  requester?: string;
}

export interface SpawnJulesResult {
  ok: boolean;
  sessionId?: string;
  sessionUrl?: string;
  prUrl?: string;
  prTitle?: string;
  /** Terminal state reported by the Jules API */
  state?: string;
  error?: string;
  durationMs: number;
}

interface JulesSession {
  name?: string;
  state?: string;
}

interface JulesPollData {
  state?: string;
  outputs?: Array<{
    pullRequest?: {
      url?: string;
      title?: string;
    };
  }>;
}

/**
 * Dispatches a task to Jules and polls until completion or timeout.
 *
 * Requires `JULES_API_KEY` to be set in the environment.
 */
export async function spawnJules(opts: SpawnJulesOptions): Promise<SpawnJulesResult> {
  const apiKey = process.env.JULES_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "JULES_API_KEY not set", durationMs: 0 };
  }

  const startMs = Date.now();
  const {
    repo,
    branch = "main",
    title,
    pollIntervalMs = 15_000,
    timeoutMs = 600_000,
  } = opts;

  // 1. Create session
  let createResp: Response;
  try {
    createResp = await fetch(`${JULES_API_BASE}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        prompt: title,
        sourceContext: {
          source: `sources/github/${repo}`,
          ref: branch,
        },
        automationMode: "AUTO_CREATE_PR",
        requirePlanApproval: false,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Jules create session network error: ${message}`, durationMs: Date.now() - startMs };
  }

  if (!createResp.ok) {
    const text = await createResp.text().catch(() => "");
    return {
      ok: false,
      error: `Jules create session failed ${createResp.status}: ${text}`,
      durationMs: Date.now() - startMs,
    };
  }

  const session = await createResp.json() as JulesSession;
  const sessionId = session.name?.split("/").pop() ?? "";
  const sessionUrl = `https://jules.google.com/task/${sessionId}`;

  // 2. Poll until terminal state
  const terminalStates = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
  let lastState = session.state ?? "RUNNING";

  while (!terminalStates.has(lastState)) {
    if (Date.now() - startMs > timeoutMs) {
      return {
        ok: false,
        sessionId,
        sessionUrl,
        state: lastState,
        error: "timeout",
        durationMs: Date.now() - startMs,
      };
    }

    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));

    let pollResp: Response;
    try {
      pollResp = await fetch(`${JULES_API_BASE}/sessions/${sessionId}`, {
        headers: { "x-goog-api-key": apiKey },
      });
    } catch {
      // Transient network error — keep polling
      continue;
    }

    if (!pollResp.ok) continue;

    const pollData = await pollResp.json() as JulesPollData;
    lastState = pollData.state ?? lastState;

    if (terminalStates.has(lastState)) {
      const pr = pollData.outputs?.[0]?.pullRequest;
      return {
        ok: lastState === "COMPLETED",
        sessionId,
        sessionUrl,
        prUrl: pr?.url,
        prTitle: pr?.title,
        state: lastState,
        durationMs: Date.now() - startMs,
      };
    }
  }

  // Exited while-loop without returning — means lastState was already terminal
  // before the first poll (edge case if create response included a terminal state).
  return {
    ok: lastState === "COMPLETED",
    sessionId,
    sessionUrl,
    state: lastState,
    durationMs: Date.now() - startMs,
  };
}
