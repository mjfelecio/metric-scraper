import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig, type AppConfig } from '../config/env.js';
import { ScrapeError } from '../core/models/errors.js';
import { createLogger, type LogLevel } from '../infrastructure/logging/pino-logger.js';
import { timestampSlug } from '../infrastructure/output/run-paths.js';
import { runLoadTest } from '../stress/load-generator/load-generator.js';
import {
  buildStressPlan,
  type StressPhase,
  type StressPlanOptions,
  type StressProfileName,
} from '../stress/load-generator/profiles.js';
import { formatStressReport } from '../stress/report/format-stress-report.js';
import { buildStressReport, type StressReport } from '../stress/report/stress-report.js';
import {
  type NamedWorkloadProfile,
  NAMED_WORKLOAD_PROFILES,
} from '../stress/workload/workload-profile.js';
import { type PlatformDistribution } from '../stress/workload/synthetic-input.js';

export interface ExecuteStressOptions {
  profile: StressProfileName;
  platform: PlatformDistribution;
  concurrency?: number | undefined;
  targetRpm?: number | undefined;
  duration?: number | undefined;
  totalJobs?: number | undefined;
  rampUp?: number | undefined;
  burst?: number | undefined;
  seed?: number | undefined;
  workload?: NamedWorkloadProfile | undefined;
  residential?: boolean | undefined;
  outputDir?: string | undefined;
  json?: boolean | undefined;
  progress?: boolean | undefined;
  logLevel?: LogLevel | undefined;
  config?: AppConfig | undefined;
}

export interface ExecuteStressResult {
  report: StressReport;
}

/**
 * Backs `scraper stress-test`. Always runs against the mock upstream --
 * there is no flag that reaches a real endpoint, so safety here is
 * structural rather than something a flag could get wrong.
 */
export async function executeStress(options: ExecuteStressOptions): Promise<ExecuteStressResult> {
  if (options.residential === true) enableResidentialPlaceholders();
  const config = options.config ?? loadConfig();
  const logger = createLogger({ level: options.logLevel ?? config.logLevel });
  const concurrency = options.concurrency ?? config.concurrency;
  const seed = options.seed ?? defaultSeedFor(options.profile);

  const planOptions: StressPlanOptions = {
    profile: options.profile,
    platform: options.platform,
    concurrency,
    ...(options.targetRpm !== undefined ? { targetRpm: options.targetRpm } : {}),
    ...(options.duration !== undefined ? { durationMs: options.duration } : {}),
    ...(options.totalJobs !== undefined ? { totalJobs: options.totalJobs } : {}),
    ...(options.rampUp !== undefined ? { rampUpMs: options.rampUp } : {}),
    ...(options.burst !== undefined ? { burst: options.burst } : {}),
    ...(options.workload !== undefined
      ? { workload: { ...NAMED_WORKLOAD_PROFILES[options.workload], seed } }
      : {}),
  };
  const plan = buildStressPlan(planOptions);

  const outputDir = options.outputDir ?? config.outputDir;
  const startedAt = new Date();
  const slug = `stress-${plan.profile}-${timestampSlug(startedAt)}`;

  if (options.progress !== false && options.json !== true) {
    process.stderr.write(
      `\nRunning stress profile "${plan.profile}" (platform: ${options.platform}, ` +
        `concurrency: ${concurrency}, seed: ${seed})\n` +
        `Phases: ${plan.phases.map(describePhase).join(' -> ')}\n`,
    );
  }

  const result = await runLoadTest({
    config,
    logger,
    plan,
    outputDir,
    onPhaseStart:
      options.progress !== false && options.json !== true
        ? (phase, index) => {
            process.stderr.write(
              `  [${index + 1}/${plan.phases.length}] ${describePhase(phase)} ...\n`,
            );
          }
        : undefined,
  });

  const report = buildStressReport(result);
  const reportPath = path.join(outputDir, `${slug}.report.json`);
  await writeStressReport(reportPath, report);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatStressReport(report));
    process.stderr.write(
      `\nReport written to ${reportPath}\nSnapshots written to ${result.snapshotsPath}\n`,
    );
  }

  if (report.verdict === 'FAIL') {
    process.exitCode = 1;
  }

  return { report };
}

function describePhase(phase: StressPhase): string {
  const rate = phase.targetRpm > 0 ? `${phase.targetRpm}rpm` : 'unpaced';
  const extent =
    phase.durationMs !== undefined
      ? `${Math.round(phase.durationMs / 1_000)}s`
      : `${phase.totalJobs} jobs`;
  return `${phase.name}(${rate}, ${extent})`;
}

function defaultSeedFor(profile: StressProfileName): number {
  // Deterministic but distinct per profile, so running two different
  // profiles back to back never accidentally shares a scenario sequence.
  return [...profile].reduce((hash, char) => hash * 31 + char.charCodeAt(0), 7) % 100_000;
}

/**
 * Fills in placeholder residential-gateway credentials when the user hasn't
 * already configured real ones, so `--residential` can exercise
 * `RotatingResidentialProxyProvider` without requiring a paid account --
 * the mock dispatcher never actually connects through them. Mutates
 * `process.env` directly (CLI-process-scoped) so the normal `loadConfig()`
 * path picks them up unmodified.
 */
function enableResidentialPlaceholders(): void {
  process.env.PROXY_MODE = 'rotating-residential';
  process.env.RESIDENTIAL_PROXY_HOST ??= 'mock-residential-gateway.local';
  process.env.RESIDENTIAL_PROXY_PORT ??= '8000';
  process.env.RESIDENTIAL_PROXY_USERNAME ??= 'stress-test';
  process.env.RESIDENTIAL_PROXY_PASSWORD ??= 'stress-test';
}

async function writeStressReport(filePath: string, report: StressReport): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new ScrapeError({
      code: 'output_error',
      message: `cannot write stress report to "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }
}
