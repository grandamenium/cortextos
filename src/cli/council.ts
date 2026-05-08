import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';

type Finding = {
  severity: 'critical' | 'warning' | 'suggestion';
  code: string;
  message: string;
};

function reviewCriteriaQuality(target: string): Finding[] {
  const findings: Finding[] = [];
  if (!existsSync(target)) {
    return [{
      severity: 'critical',
      code: 'missing-target',
      message: `Target file not found: ${target}`,
    }];
  }

  const content = readFileSync(target, 'utf-8');
  const validation = content.match(/^## Validation\s*\n+([\s\S]*?)(?=\n## |\n# |\s*$)/m)?.[1]?.trim() || '';

  if (!/^## Success criteria\s*$/m.test(content)) {
    findings.push({
      severity: 'critical',
      code: 'missing-success-criteria',
      message: 'Missing ## Success criteria section.',
    });
  }

  if (!validation) {
    findings.push({
      severity: 'critical',
      code: 'missing-validation',
      message: 'Missing exact validation command under ## Validation.',
    });
  }

  if (/pytest\s+-k\s+["']?\s*not\b/i.test(validation) || /pytest\s+-k\s+["']?\s*not\b/i.test(content)) {
    findings.push({
      severity: 'critical',
      code: 'filtered-pytest',
      message: 'Criteria or validation are gameable with pytest -k "not ...".',
    });
  }

  if (/(#\s*type:\s*ignore|@ts-expect-error)/.test(content)) {
    findings.push({
      severity: 'critical',
      code: 'type-suppression',
      message: 'Criteria mention type suppression escape hatches.',
    });
  }

  if (/(delete|remove|disable|skip|ignore).{0,50}tests?/i.test(content)) {
    findings.push({
      severity: 'critical',
      code: 'test-removal',
      message: 'Criteria appear satisfiable by deleting, disabling, skipping, or ignoring tests.',
    });
  }

  if (/assert\s+(true|1)\b|no-?op assertion|weaken assertions?/i.test(content)) {
    findings.push({
      severity: 'critical',
      code: 'assertion-weakening',
      message: 'Criteria appear satisfiable by weakening or no-oping assertions.',
    });
  }

  return findings;
}

export const councilCommand = new Command('council')
  .description('Local adversarial review helpers');

councilCommand
  .command('review')
  .requiredOption('--target <path>', 'File to review')
  .requiredOption('--rubric <name>', 'Rubric name')
  .description('Review a target file against a named rubric')
  .action((opts: { target: string; rubric: string }) => {
    if (opts.rubric !== 'criteria-quality') {
      console.error(`Unknown rubric: ${opts.rubric}`);
      process.exit(2);
    }

    const findings = reviewCriteriaQuality(opts.target);
    const criticals = findings.filter((finding) => finding.severity === 'critical');
    console.log(JSON.stringify({
      target: opts.target,
      rubric: opts.rubric,
      passed: criticals.length === 0,
      findings,
    }, null, 2));

    if (criticals.length > 0) {
      process.exit(2);
    }
  });
