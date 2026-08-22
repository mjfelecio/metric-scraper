import type { CapacityFindingCode, ProvenanceKind } from '../../core/capacity/index.js';

/** Copy lives outside the renderer so terminology stays consistent across the page. */
export interface InputDocumentation {
  readonly id: string;
  readonly path?: string;
  readonly explanation: string;
}

export const INPUT_DOCUMENTATION: readonly InputDocumentation[] = [
  {
    id: 'platform-preset',
    explanation:
      'Loads platform-specific fan-out, payload, and HTTP limit defaults. Choose Custom when those measurements do not apply.',
  },
  {
    id: 'lifecycle-preset',
    path: 'stages',
    explanation:
      'Loads the age-based polling schedule. Changing it changes how many times every submission becomes a scraping job.',
  },
  {
    id: 'new-submissions',
    path: 'newSubmissionsPerDay',
    explanation:
      'New URLs entering the lifecycle each day. A submission remains active until it ages through every enabled stage.',
  },
  {
    id: 'horizon-days',
    path: 'horizonDays',
    explanation:
      'How many launch days to simulate. It changes horizon totals and whether plateaus are visible, but not 30-day steady-state run rates.',
  },
  {
    id: 'requests-per-job',
    path: 'requestsPerJob',
    explanation:
      'Average outbound HTTP requests needed to perform one logical scrape job. TikTok currently uses about two, so jobs and HTTP requests are not interchangeable.',
  },
  {
    id: 'bytes-per-request',
    path: 'bytesPerHttpRequest',
    explanation:
      'Average transferred payload for one outbound HTTP request. The TikTok planning preset is 25,500 bytes, or about 25.5 decimal KB.',
  },
  {
    id: 'mean-job-latency',
    path: 'meanJobLatencyMs',
    explanation:
      'Average elapsed time for a complete logical scrape job. It sizes normal in-flight job concurrency.',
  },
  {
    id: 'p95-job-latency',
    path: 'p95JobLatencyMs',
    explanation:
      '95% of complete jobs finish within this time; the slowest 5% take longer. It sizes peak job concurrency.',
  },
  {
    id: 'mean-http-latency',
    path: 'meanHttpLatencyMs',
    explanation:
      'Average service time for one outbound HTTP request, measured independently from whole-job latency. Leave unset when it has not been observed.',
  },
  {
    id: 'p95-http-latency',
    path: 'p95HttpLatencyMs',
    explanation:
      'Time within which 95% of individual HTTP requests finish. It is required to estimate peak HTTP concurrency.',
  },
  {
    id: 'attempt-success-rate',
    path: 'reliability.perAttemptSuccessRate',
    explanation:
      'Chance that one retry-eligible attempt succeeds. This differs from eventual job success because a later retry can recover the job.',
  },
  {
    id: 'permanent-failure-share',
    path: 'reliability.nonRetryableShare',
    explanation:
      'Share of jobs that fail with a terminal result such as private, not found, or parse error. These jobs do not retry.',
  },
  {
    id: 'max-attempts',
    path: 'reliability.maxAttempts',
    explanation:
      'Maximum total attempts for a retryable job, including its first attempt. Three attempts means at most two retries.',
  },
  {
    id: 'retry-initial-delay',
    explanation:
      'Wait before the first retry. Backoff occupies a worker slot while the proxy lease is released.',
  },
  {
    id: 'retry-max-delay',
    explanation:
      'Upper bound on exponential retry delay so repeated failures do not wait indefinitely.',
  },
  {
    id: 'retry-factor',
    explanation:
      'Multiplier applied to each successive retry delay until the maximum delay is reached.',
  },
  {
    id: 'retry-jitter',
    explanation:
      'Randomizes retry waits to prevent many failed jobs from retrying at exactly the same time.',
  },
  {
    id: 'job-target-rpm',
    path: 'capacity.targetJobsPerMinute',
    explanation:
      'Per-process admission ceiling for logical jobs. This is throughput over time, not the number of jobs simultaneously in flight.',
  },
  {
    id: 'peak-multiplier',
    path: 'capacity.peakMultiplier',
    explanation:
      'Scales steady jobs/minute into a planning peak when no explicit peak override is supplied.',
  },
  {
    id: 'peak-override',
    explanation:
      'Known absolute peak jobs/minute. When supplied, it takes precedence over the peak multiplier.',
  },
  {
    id: 'workers',
    path: 'capacity.workers',
    explanation:
      'Independent scraper processes. Job concurrency, admission, and HTTP egress limits are process-local and aggregate across workers.',
  },
  {
    id: 'worker-concurrency',
    path: 'capacity.concurrencyPerWorker',
    explanation:
      'Maximum logical jobs one worker can keep in flight. Slower jobs need more slots to sustain the same throughput.',
  },
  {
    id: 'http-rpm-limit',
    path: 'capacity.httpRpmPerHost',
    explanation:
      'Per-worker outbound HTTP request ceiling for the platform host. It limits HTTP attempts, not logical job admission.',
  },
  {
    id: 'proxy-pool-size',
    path: 'capacity.proxyPoolSize',
    explanation:
      'Number of static proxies currently configured and available to share the modeled traffic.',
  },
  {
    id: 'proxy-concurrency-limit',
    path: 'capacity.proxyLimits.maxConcurrentPerProxy',
    explanation:
      'Maximum simultaneous job leases one proxy may carry. This can become the binding proxy constraint.',
  },
  {
    id: 'proxy-rpm-limit',
    path: 'capacity.proxyLimits.maxRequestsPerMinutePerProxy',
    explanation:
      'Vendor or operational request-rate limit for each static proxy. Leave unset when the plan has no known RPM cap.',
  },
  {
    id: 'proxy-bandwidth-limit',
    path: 'capacity.proxyLimits.maxBytesPerMonthPerProxy',
    explanation:
      'Monthly byte allowance for each static proxy. Unlimited-bandwidth plans should leave this unset.',
  },
  {
    id: 'proxy-probation',
    path: 'capacity.proxyLimits.probationConcurrency',
    explanation:
      'Conservative starting concurrency granted to a new or recovering proxy before it proves healthy.',
  },
  {
    id: 'proxy-earned',
    path: 'capacity.proxyLimits.earnedConcurrencyPerProxy',
    explanation:
      'Observed warm-pool concurrency each proxy actually earns after health-based increases and reductions.',
  },
  {
    id: 'safety-margin',
    path: 'capacity.safetyMargin',
    explanation:
      'Extra capacity added after the theoretical proxy requirement. A 0.20 margin turns a raw 3.72 proxies into a recommendation of 5.',
  },
  {
    id: 'price-per-gb',
    path: 'pricing.pricePerGb',
    explanation:
      'Variable price for one selected billing unit. Numeric zero explicitly means bandwidth is free; blank means unknown.',
  },
  {
    id: 'billing-unit',
    explanation:
      'Choose decimal GB (1 billion bytes) or binary GiB (1,073,741,824 bytes) to match the vendor invoice.',
  },
  {
    id: 'bill-failed-attempts',
    explanation:
      'Controls whether failed HTTP attempts contribute to billable bandwidth. Actual traffic still includes those attempts.',
  },
  {
    id: 'price-per-proxy',
    path: 'pricing.fixedMonthlyPerProxy',
    explanation:
      'Monthly fixed charge multiplied by the recommended steady-state static proxy count.',
  },
  {
    id: 'fixed-pool-price',
    path: 'pricing.fixedMonthlyPool',
    explanation:
      'Monthly commitment charged once for the pool, independent of traffic or proxy count. Zero means no pool charge.',
  },
  {
    id: 'growth-enabled',
    explanation:
      'When enabled, submissions compound monthly and propagate through jobs, traffic, bandwidth, proxies, and cost.',
  },
  {
    id: 'growth-rate',
    path: 'growth.monthlyGrowthRate',
    explanation:
      'Fractional month-over-month submission growth. Enter 0.10 for 10% compound growth.',
  },
  {
    id: 'growth-months',
    explanation:
      'Number of monthly planning rows to produce. Month 1 always represents today’s baseline.',
  },
];

export const METRIC_DOCUMENTATION: Readonly<Record<string, string>> = {
  currentSubmissionsDay:
    'New submissions entering each day. The polling lifecycle—not a fixed scrape count—turns these arrivals into recurring work.',
  steadyStateJobsDay:
    'Logical scrape jobs/day after every polling age cohort is populated under the current lifecycle.',
  sustainableJobsDay:
    'The lowest configured steady-state ceiling across worker concurrency, job admission, HTTP egress, and applicable static-proxy limits.',
  capacityUtilization:
    'Steady-state logical jobs/day divided by sustainable logical-job capacity/day. Over 100% means configured infrastructure cannot sustain the workload.',
  capacityHeadroom:
    'Sustainable logical-job capacity minus current steady-state workload. This is recurring capacity, not burst headroom.',
  overCapacityJobsDay:
    'Current steady-state logical jobs/day beyond the sustainable infrastructure ceiling.',
  maximumSubmissionsDay:
    'The daily arrival rate whose lifecycle-generated steady-state workload reaches system capacity. It is derived by inverting the current polling profile.',
  systemBindingConstraint:
    'The worker or static-proxy constraint with the lowest sustainable logical-job throughput. Improving another constraint will not raise capacity until this one moves.',
  lifetimeScrapesPerSubmission:
    'Total scheduled scrape jobs one submission receives while moving through the current lifecycle. This is derived and cannot be edited independently.',
  activeSubmissions:
    'Submissions still inside any enabled lifecycle stage, including dormant stages that retain but no longer poll them.',
  polledSubmissions:
    'Active submissions currently in a stage with a polling interval. These are the population generating recurring jobs.',
  logicalJobsDay:
    'One logical job is one scheduled scrape of one URL. The lifecycle determines how many jobs each submission creates per day.',
  logicalJobsMonth: 'Thirty times the steady-state logical jobs/day run rate.',
  horizonJobs:
    'Total logical jobs across the selected launch simulation, including its ramp. This is separate from steady-state monthly run rate.',
  pollingPlateau:
    'First simulated day when every polling age is populated and recurring jobs stop increasing.',
  activePlateau:
    'First day when the complete lifecycle is populated, including any dormant retention tail.',
  jobSuccess:
    'Share of logical jobs expected to eventually succeed after allowed retries. It is not first-attempt success.',
  permanentFailures:
    'Jobs expected to end immediately with a non-retryable result such as private, not found, or parse error.',
  retryRate: 'Share of all logical jobs expected to make at least one additional attempt.',
  attemptAmplification:
    'Expected attempts per logical job. 1.0× means no retry traffic; values above 1.0 multiply HTTP requests and bandwidth.',
  retriesDay: 'Expected additional job attempts each steady-state day, excluding first attempts.',
  expectedBackoff:
    'Average retry sleep carried by each logical job. The worker slot stays occupied during this wait, while the proxy lease is released.',
  baselineHttpDay: 'HTTP requests/day before retry attempts: logical jobs/day × HTTP requests/job.',
  adjustedHttpDay:
    'Expected actual HTTP requests/day after attempt amplification. Capacity and bandwidth use this retry-adjusted value.',
  baselineHttpMonth: 'Thirty days of steady-state HTTP traffic before retries.',
  adjustedHttpMonth: 'Thirty days of steady-state expected HTTP traffic including retries.',
  adjustedHttpHorizon:
    'Retry-adjusted HTTP requests across only the selected launch simulation horizon.',
  baselineBandwidthDay: 'Daily HTTP traffic × average bytes/request, before retry attempts.',
  baselineBandwidthMonth: 'Thirty-day steady-state bandwidth before retry attempts.',
  adjustedBandwidthDay: 'Expected daily bytes transferred after retries increase HTTP traffic.',
  adjustedBandwidthMonth:
    'Expected 30-day steady-state bandwidth used for capacity and variable cost.',
  baselineBandwidthHorizon:
    'Pre-retry bytes across the selected launch simulation rather than a steady month.',
  adjustedBandwidthHorizon:
    'Retry-adjusted bytes across the selected launch simulation rather than a steady month.',
  averageJobsConcurrency:
    'Modeled logical jobs simultaneously in flight at average throughput and mean job latency.',
  peakJobsConcurrency:
    'Modeled jobs in flight at peak jobs/minute and P95 job latency. P95 means 95% finish within that latency.',
  averageHttpConcurrency:
    'Modeled individual HTTP requests in flight using adjusted HTTP throughput and mean HTTP latency.',
  peakHttpConcurrency:
    'Modeled HTTP requests in flight at peak adjusted traffic and P95 HTTP latency.',
  peakJobsMinute: 'Peak logical job throughput used for peak sizing.',
  peakSource:
    'Whether peak jobs/minute came from the explicit override or from steady throughput × peak multiplier.',
  configuredSlots:
    'Worker processes × job concurrency per worker: total process-local job slots available.',
  jobTargetMinute:
    'Worker processes × target jobs/minute: aggregate logical job admission ceiling.',
  httpLimitMinute: 'Worker processes × HTTP RPM/host: aggregate outbound request ceiling.',
  workersByConcurrency:
    'Workers needed to hold the modeled average in-flight jobs at the configured slots per worker.',
  workersByTarget:
    'Workers needed for steady logical jobs/minute at the configured per-worker admission target.',
  recommendedWorkers:
    'Largest computable worker requirement across concurrency, job admission, and HTTP egress constraints.',
  bindingConstraint:
    'The proxy constraint currently requiring the largest pool: job concurrency, HTTP RPM, or monthly bandwidth.',
  rawProxyRequirement:
    'Exact proxy demand from the binding constraint before rounding or safety margin.',
  theoreticalProxies:
    'Raw proxy demand rounded up to a whole static proxy, before operational safety margin.',
  recommendedProxies:
    'Raw steady-state proxy demand plus the configured safety margin, then rounded up. This is a planning recommendation, not an absolute guarantee.',
  configuredProxyUtilization:
    'Raw required proxies divided by configured pool size. Over 100% means modeled demand exceeds the pool.',
  configuredProxyHeadroom:
    'Configured pool size minus recommended proxies. Negative values indicate a shortfall.',
  requestsPerProxyDay:
    'Retry-adjusted daily HTTP traffic divided across the currently configured static pool.',
  concurrencyPerProxy:
    'Average in-flight job demand divided across the currently configured static pool.',
  billableBandwidth:
    'Monthly bandwidth units used for pricing after applying whether failed attempts are billable.',
  bandwidthCost: 'Billable monthly bandwidth × price per selected GB or GiB unit.',
  proxyCost: 'Recommended steady-state static proxy count × monthly price/proxy.',
  fixedPoolCost: 'One fixed monthly pool commitment, independent of traffic and proxy count.',
  totalCost:
    'Bandwidth, per-proxy, and fixed-pool monthly charges combined. It remains unavailable until every price is explicitly supplied; zero is a valid free price.',
};

export interface FindingDocumentation {
  readonly title: string;
  readonly why: string;
  readonly action: string;
}

export const FINDING_DOCUMENTATION: Record<CapacityFindingCode, FindingDocumentation> = {
  no_enabled_stages: {
    title: 'No polling workload',
    why: 'Without an enabled lifecycle stage, submissions never create scrape jobs.',
    action: 'Enable an existing stage or add a stage before using the capacity result.',
  },
  no_submissions: {
    title: 'No submissions enter the model',
    why: 'Zero daily arrivals produce no active population or recurring workload.',
    action: 'Enter the expected submissions/day when planning a real deployment.',
  },
  horizon_shorter_than_lifecycle: {
    title: 'Simulation ends before the lifecycle fills',
    why: 'Horizon totals show only the launch ramp, while the active population is still growing.',
    action:
      'Extend the horizon to see the active-lifecycle plateau; steady run-rate metrics remain separate.',
  },
  dormant_stage_present: {
    title: 'Some active submissions are dormant',
    why: 'A dormant stage retains submissions in the lifecycle without generating new scrape jobs.',
    action: 'Confirm that retention without polling matches the operating policy.',
  },
  sparse_polling: {
    title: 'Stage contains no polling instant',
    why: 'The configured interval and stage duration do not schedule a scrape inside that stage.',
    action: 'Shorten the interval, extend the stage, or intentionally leave the interval blank.',
  },
  latency_unknown: {
    title: 'Job concurrency cannot be sized',
    why: 'Throughput alone cannot reveal how many jobs remain in flight; job latency is also required.',
    action:
      'Supply measured mean and P95 job latency before relying on worker or proxy concurrency sizing.',
  },
  egress_below_demand: {
    title: 'HTTP egress limit is below modeled demand',
    why: 'Retry-adjusted HTTP requests/minute exceed the aggregate per-host limit across workers.',
    action: 'Add workers, raise a safe per-host limit, or reduce the workload/fan-out.',
  },
  admission_below_demand: {
    title: 'Job admission target is below modeled demand',
    why: 'The workers cannot admit logical jobs as quickly as the steady lifecycle produces them.',
    action: 'Add workers, raise the safe job target, or reduce the scheduled polling workload.',
  },
  concurrency_below_demand: {
    title: 'Configured job slots are below modeled demand',
    why: 'Expected in-flight jobs exceed workers × job concurrency, so work will queue.',
    action:
      'Increase worker count or per-worker concurrency after validating upstream and proxy limits.',
  },
  proxy_pool_below_demand: {
    title: 'Static proxy pool is below the recommendation',
    why: 'The configured pool has fewer proxies than modeled demand plus safety margin requires.',
    action: 'Add static proxies or revisit the binding per-proxy limit and safety margin.',
  },
  proxy_limits_unknown: {
    title: 'Static proxy requirement is uncertain',
    why: 'No usable per-proxy concurrency, RPM, or bandwidth constraint can size the pool.',
    action: 'Measure or configure at least one applicable per-proxy capacity limit.',
  },
  proxy_oversubscribed: {
    title: 'Static proxies are oversubscribed',
    why: 'Modeled demand per proxy exceeds an applicable limit.',
    action: 'Increase pool size or reduce demand before treating the plan as sustainable.',
  },
  proxy_cold_start_gap: {
    title: 'Configured proxy capacity exceeds observed earned capacity',
    why: 'Healthy proxies ramp from probation and may not sustain their configured ceiling.',
    action: 'Plan around measured earned capacity until longer runs validate the higher ceiling.',
  },
  cycle_burst_exceeds_interval: {
    title: 'A polling cycle may overlap the next interval',
    why: 'The modeled work cannot finish within its scheduled start-to-start gap.',
    action: 'Increase capacity, lengthen the interval, or reduce the cohort polled in that stage.',
  },
  retry_amplification_high: {
    title: 'Retries materially amplify traffic',
    why: 'Failed attempts are adding substantial HTTP requests and bandwidth per logical job.',
    action:
      'Investigate upstream, proxy, and parsing failures before buying capacity for avoidable retries.',
  },
  pricing_unknown: {
    title: 'Monthly cost is incomplete',
    why: 'At least one required price is blank. Blank means unknown, while numeric zero explicitly means free.',
    action:
      'Supply every applicable bandwidth, per-proxy, and fixed-pool price to compute a total.',
  },
  target_below_demand: {
    title: 'Configured target is below workload',
    why: 'The admission target cannot keep pace with modeled logical jobs.',
    action: 'Raise safe capacity or reduce scheduled demand.',
  },
  target_above_demand: {
    title: 'Job target has substantial headroom',
    why: 'The configured admission target is more than twice the modeled average job rate.',
    action:
      'No change is required; verify that concurrency and HTTP egress can also support the target.',
  },
  workers_exceed_process_limits: {
    title: 'Worker plan conflicts with process-local limits',
    why: 'Adding workers changes aggregate capacity because limits apply independently in each process.',
    action: 'Validate host-wide upstream and proxy limits before scaling process count.',
  },
};

export const PROVENANCE_DOCUMENTATION: Record<ProvenanceKind, string> = {
  measured: 'Observed from actual scraper runs or run artifacts.',
  config: 'Explicitly chosen system or environment setting.',
  assumption: 'Planning value that has not yet been validated by measurement.',
  unset: 'No value has been provided, so dependent calculations may be unavailable.',
};

export const PROVENANCE_INPUT_LABELS: Readonly<Record<string, string>> = {
  newSubmissionsPerDay: 'New submissions/day',
  horizonDays: 'Simulation horizon',
  stages: 'Polling lifecycle',
  requestsPerJob: 'HTTP requests/job',
  bytesPerHttpRequest: 'Bytes/HTTP request',
  meanJobLatencyMs: 'Mean job latency',
  p95JobLatencyMs: 'P95 job latency',
  meanHttpLatencyMs: 'Mean HTTP latency',
  p95HttpLatencyMs: 'P95 HTTP latency',
  'reliability.perAttemptSuccessRate': 'Retryable attempt success',
  'reliability.nonRetryableShare': 'Permanent failure share',
  'reliability.maxAttempts': 'Maximum attempts',
  'capacity.targetJobsPerMinute': 'Job target/min/worker',
  'capacity.concurrencyPerWorker': 'Job concurrency/worker',
  'capacity.workers': 'Worker processes',
  'capacity.httpRpmPerHost': 'HTTP RPM/host/worker',
  'capacity.proxyPoolSize': 'Configured proxy pool',
  'capacity.proxyLimits.maxConcurrentPerProxy': 'Concurrency/proxy',
  'capacity.proxyLimits.probationConcurrency': 'Probation concurrency',
  'capacity.proxyLimits.earnedConcurrencyPerProxy': 'Earned concurrency/proxy',
  'capacity.proxyLimits.maxRequestsPerMinutePerProxy': 'Requests/min/proxy',
  'capacity.proxyLimits.maxBytesPerMonthPerProxy': 'Bytes/month/proxy',
  'capacity.peakMultiplier': 'Peak multiplier',
  'capacity.safetyMargin': 'Safety margin',
  'pricing.pricePerGb': 'Price/bandwidth unit',
  'pricing.fixedMonthlyPerProxy': 'Monthly price/proxy',
  'pricing.fixedMonthlyPool': 'Fixed monthly pool price',
  'growth.monthlyGrowthRate': 'Monthly growth rate',
};
