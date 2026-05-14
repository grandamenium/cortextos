import { Command } from 'commander';
import { runAllChecks, type Check } from '../utils/health-checks.js';

export const doctorCommand = new Command('doctor')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Diagnose common issues')
  .action(async (options: { instance: string }) => {
    console.log('\ncortextOS Doctor\n');

    const checks = await runAllChecks({
      instanceId: options.instance,
      frameworkRoot: process.cwd(),
    });

    renderChecks(checks);

    const warnCount = checks.filter((c) => c.status === 'warn').length;
    const failCount = checks.filter((c) => c.status === 'fail').length;

    console.log('');
    if (failCount > 0) {
      console.log(`  ${failCount} check(s) failed. Fix the issues above and run doctor again.\n`);
      process.exit(1);
    } else if (warnCount > 0) {
      console.log(`  All critical checks passed, ${warnCount} warning(s). See above for details.\n`);
    } else {
      console.log('  All checks passed.\n');
    }
  });

function renderChecks(checks: Check[]): void {
  for (const check of checks) {
    const icon = check.status === 'pass' ? 'OK' : check.status === 'warn' ? 'WARN' : 'FAIL';
    const prefix = `  [${icon}]`;
    console.log(`${prefix.padEnd(10)} ${check.name}: ${check.message}`);
    if (check.fix) {
      console.log(`           Fix: ${check.fix}`);
    }
  }
}
