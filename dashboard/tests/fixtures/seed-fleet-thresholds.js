#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const homeRoot = process.argv[2];

if (!homeRoot) {
  process.stderr.write('usage: node tests/fixtures/seed-fleet-thresholds.js <CORTEXTOS_HOME>\n');
  process.exit(1);
}

const org = 'clearworksai';
const now = Date.now();
const today = new Date().toISOString().slice(0, 10);

const fixtures = [
  { agent: 'a-green', timestamp: new Date(now - 30 * 1000).toISOString(), event: 'dispatch_started' },
  { agent: 'a-amber', timestamp: new Date(now - 15 * 60 * 1000).toISOString(), event: 'task_blocked' },
  { agent: 'a-red', timestamp: new Date(now - 60 * 60 * 1000).toISOString(), event: 'heartbeat' },
];

for (const fixture of fixtures) {
  const eventDir = path.join(homeRoot, 'orgs', org, 'analytics', 'events', fixture.agent);
  fs.mkdirSync(eventDir, { recursive: true });
  const eventFile = path.join(eventDir, `${today}.jsonl`);
  const line = JSON.stringify({
    id: `${fixture.agent}-${Date.parse(fixture.timestamp)}`,
    agent: fixture.agent,
    org,
    timestamp: fixture.timestamp,
    category: 'action',
    event: fixture.event,
    severity: 'info',
    metadata: {},
  });
  fs.writeFileSync(eventFile, `${line}\n`, 'utf8');
}
