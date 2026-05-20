import { readFileSync } from 'fs';
import { findTaskFile } from './task.js';
import type { Task, BusPaths } from '../types/index.js';

export interface ValidationResult {
  score: number;           // 1–10
  verdict: 'pass' | 'fail' | 'needs-revision';
  reasoning: string;
  task_id: string;
}

function buildPrompt(task: Task): string {
  return `You are a task completion validator. Score whether a task was completed per its success criteria.

TASK: ${task.title}
DESCRIPTION: ${task.description || '(none)'}
SUCCESS CRITERIA: ${task.success_criteria}
COMPLETION RESULT: ${task.result || '(no result provided)'}

Score the completion 1-10:
- 1-4: FAIL — success criteria clearly not met
- 5-6: NEEDS-REVISION — partial or unclear completion
- 7-10: PASS — success criteria met

Respond with ONLY valid JSON, no other text:
{"score": <1-10>, "verdict": "<pass|fail|needs-revision>", "reasoning": "<one concise sentence>"}`;
}

async function callClaude(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content.find(b => b.type === 'text')?.text ?? '';
}

function parseResponse(raw: string, taskId: string): ValidationResult {
  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/m, '').replace(/\n?```$/m, '').trim();
    const parsed = JSON.parse(cleaned) as { score: number; verdict: string; reasoning: string };
    const score = Math.max(1, Math.min(10, Math.round(Number(parsed.score))));
    let verdict: 'pass' | 'fail' | 'needs-revision';
    if (['pass', 'fail', 'needs-revision'].includes(parsed.verdict)) {
      verdict = parsed.verdict as 'pass' | 'fail' | 'needs-revision';
    } else {
      verdict = score >= 7 ? 'pass' : score >= 5 ? 'needs-revision' : 'fail';
    }
    return { score, verdict, reasoning: String(parsed.reasoning ?? ''), task_id: taskId };
  } catch {
    throw new Error(`LLM returned unparseable response: ${raw.slice(0, 200)}`);
  }
}

export async function validateTask(
  paths: BusPaths,
  taskId: string,
): Promise<ValidationResult> {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) throw new Error(`Task ${taskId} not found`);

  const task: Task = JSON.parse(readFileSync(filePath, 'utf-8'));

  if (!task.success_criteria) {
    return {
      score: 7,
      verdict: 'pass',
      reasoning: 'No success_criteria defined — auto-pass.',
      task_id: taskId,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const prompt = buildPrompt(task);
  const raw = await callClaude(apiKey, prompt);
  return parseResponse(raw, taskId);
}
