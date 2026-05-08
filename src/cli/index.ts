import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { initCommand } from './init.js';
import { addAgentCommand } from './add-agent.js';
import { startCommand } from './start.js';
import { stopCommand } from './stop.js';
import { restartCommand } from './restart.js';
import { statusCommand } from './status.js';
import { doctorCommand } from './doctor.js';
import { busCommand } from './bus.js';
import { listAgentsCommand } from './list-agents.js';
import { notifyAgentCommand } from './notify-agent.js';
import { listSkillsCommand } from './list-skills.js';
import { installCommand } from './install.js';
import { enableAgentCommand, disableAgentCommand } from './enable-agent.js';
import { ecosystemCommand } from './ecosystem.js';
import { uninstallCommand } from './uninstall.js';
import { dashboardCommand } from './dashboard.js';
import { tunnelCommand } from './tunnel.js';
import { getConfigCommand } from './get-config.js';
import { goalsCommand } from './goals.js';
import { setupCommand } from './setup.js';
import { spawnWorkerCommand, terminateWorkerCommand, listWorkersCommand, injectWorkerCommand } from './workers.js';
import { importAgentCommand } from './import-agent.js';

const program = new Command();

program
  .name('cortextos')
  .description('Persistent 24/7 Claude Code agents with multi-agent orchestration')
  .version('0.1.1');

program.addCommand(initCommand);
program.addCommand(installCommand);
program.addCommand(addAgentCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(doctorCommand);
program.addCommand(busCommand);
program.addCommand(listAgentsCommand);
program.addCommand(notifyAgentCommand);
program.addCommand(listSkillsCommand);
program.addCommand(enableAgentCommand);
program.addCommand(disableAgentCommand);
program.addCommand(ecosystemCommand);
program.addCommand(uninstallCommand);
program.addCommand(dashboardCommand);
program.addCommand(tunnelCommand);
program.addCommand(getConfigCommand);
program.addCommand(goalsCommand);
program.addCommand(setupCommand);
program.addCommand(spawnWorkerCommand);
program.addCommand(terminateWorkerCommand);
program.addCommand(listWorkersCommand);
program.addCommand(injectWorkerCommand);
program.addCommand(importAgentCommand);

// crash-alert: SessionEnd hook — cross-platform replacement for crash-alert.sh
const crashAlertCommand = new Command('crash-alert')
  .description('SessionEnd hook: send crash/restart notification via Telegram (cross-platform)')
  .action(() => {
    const hookPath = join(__dirname, 'hooks/hook-crash-alert.js');
    const result = spawnSync(process.execPath, [hookPath], { stdio: 'inherit' });
    process.exit(result.status ?? 0);
  });
program.addCommand(crashAlertCommand);

program.parse();
