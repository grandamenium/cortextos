import { Command } from 'commander';
import { SlackAPI, loadSlackIdentity, type PostMessageRequest } from '../slack/index.js';

export interface TestSendOptions {
  frameworkRoot: string;
  org: string;
  agent?: string;
  channel: string;
  text: string;
}

/** Pure function — testable without process exit. */
export async function runTestSend(opts: TestSendOptions, api: SlackAPI): Promise<void> {
  const req: PostMessageRequest = { channel: opts.channel, text: opts.text };
  if (opts.agent) {
    const id = loadSlackIdentity(opts.frameworkRoot, opts.org, opts.agent);
    if (!id) throw new Error(`agent "${opts.agent}" has no slack.json (not Slack-enabled)`);
    req.username = id.username;
    if (id.icon_emoji) req.icon_emoji = id.icon_emoji;
    if (id.icon_url) req.icon_url = id.icon_url;
  }
  await api.postMessage(req);
}

function requireToken(): string {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('SLACK_BOT_TOKEN not set. SP3a runbook covers the setup.');
    process.exit(1);
  }
  return token;
}

const testSendCommand = new Command('test-send')
  .argument('<channel>', 'Slack channel id (Cxxx) or name (#general)')
  .argument('<text>', 'Message text')
  .option('--as <agent>', 'Post under this agent\'s identity (loads slack.json)')
  .option('--org <org>', 'Org', 'wyre')
  .description('Post a test message to a Slack channel')
  .action(async (channel: string, text: string, options: { as?: string; org: string }) => {
    const api = new SlackAPI(requireToken());
    const frameworkRoot =
      process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
    try {
      await runTestSend({ frameworkRoot, org: options.org, agent: options.as, channel, text }, api);
      console.log('sent');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

const discoverChannelsCommand = new Command('discover-channels')
  .description('List Slack channels the bot is a member of (with ids)')
  .action(async () => {
    const api = new SlackAPI(requireToken());
    const channels = await api.listChannels();
    const visible = channels.filter((c) => c.is_member !== false);
    for (const c of visible) {
      const prefix = c.is_private ? '🔒' : '#';
      console.log(`${c.id}\t${prefix}${c.name}`);
    }
  });

export const slackCommand = new Command('slack')
  .description('Slack adapter ops')
  .addCommand(testSendCommand)
  .addCommand(discoverChannelsCommand);
