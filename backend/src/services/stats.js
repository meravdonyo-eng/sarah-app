/**
 * stats.js — Deterministic statistical compute engine for Sarah.
 *
 * ALL significance math runs here in server-side code.
 * Claude NEVER computes statistics — she only presents the returned result object.
 * No external dependencies — math implemented from well-known approximations.
 *
 * Phase 1: ab_proportion  — two-proportion z-test (A/B experiments)
 * Phase 2: cohort_retention — pairwise per-period comparison (planned)
 */

// ---------------------------------------------------------------------------
// Math primitives
// ---------------------------------------------------------------------------

/**
 * Normal CDF — Abramowitz & Stegun (1964), formula 26.2.17.
 * Max absolute error: 7.5 × 10^-8.
 */
function normCDF(x) {
  const a = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
  const L = Math.abs(x);
  const K = 1 / (1 + 0.2316419 * L);
  let poly = 0;
  for (let i = 4; i >= 0; i--) poly = a[i] + K * poly;
  poly *= K;
  const cdf = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * L * L) * poly;
  return x < 0 ? 1 - cdf : cdf;
}

/**
 * Error function — Abramowitz & Stegun 7.1.26.
 * Max absolute error: 1.5 × 10^-7.
 */
function erf(x) {
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const p = 0.3275911;
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  let poly = 0;
  for (let i = 4; i >= 0; i--) poly = a[i] + t * poly;
  poly *= t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/**
 * Chi-squared p-value with 1 degree of freedom.
 * P(χ²(1) > x) = erfc(sqrt(x/2)) = 1 - erf(sqrt(x/2))
 */
function chi2p1df(x) {
  if (x <= 0) return 1;
  return 1 - erf(Math.sqrt(x / 2));
}

// ---------------------------------------------------------------------------
// Tool definition (registered in Claude's tools array)
// ---------------------------------------------------------------------------

export const STATS_TOOLS = [
  {
    name: 'compute_significance',
    description:
      'Run a deterministic statistical test on experiment or cohort data and return ' +
      'significance, lift, confidence interval, sample-size/power, and data-quality flags. ' +
      'Use ONLY when raw counts (n + conversions per arm) are already available in context. ' +
      'NEVER estimate these values without this tool — no mental math, no approximations.',
    input_schema: {
      type: 'object',
      properties: {
        test_type: {
          type: 'string',
          enum: ['ab_proportion', 'cohort_retention'],
          description: 'Statistical test to run.',
        },
        alpha: {
          type: 'number',
          description: 'Significance threshold (default 0.05).',
        },
        direction: {
          type: 'string',
          enum: ['two_tailed', 'one_tailed'],
          description: 'two_tailed (default) or one_tailed (variant > control).',
        },
        control: {
          type: 'object',
          description: 'Required for ab_proportion. Must include n (total users) and conversions (converted users).',
          properties: {
            n:           { type: 'integer', description: 'Total users in control arm.' },
            conversions: { type: 'integer', description: 'Converted users in control arm.' },
          },
        },
        variant: {
          type: 'object',
          description: 'Required for ab_proportion. Must include n (total users) and conversions (converted users).',
          properties: {
            n:           { type: 'integer', description: 'Total users in variant arm.' },
            conversions: { type: 'integer', description: 'Converted users in variant arm.' },
          },
        },
        mde: {
          type: 'number',
          description: 'Optional. Minimum detectable effect (relative, e.g. 0.05 = 5%) for power check.',
        },
        expected_split: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional. Designed traffic split [0.5, 0.5] for Sample Ratio Mismatch check.',
        },
        cohorts: {
          type: 'array',
          description: 'Required for cohort_retention. Each item: { id: string, size: integer, retained_by_period: integer[] }.',
          items: {
            type: 'object',
            properties: {
              id:   { type: 'string', description: 'Cohort identifier.' },
              size: { type: 'integer', description: 'Total cohort size.' },
              retained_by_period: {
                type: 'array',
                items: { type: 'integer' },
                description: 'Count still active per period index (0 = first period).',
              },
            },
          },
        },
        source: {
          type: 'string',
          description: 'Provenance string passed through to output unchanged. e.g. "Mixpanel: experiment XYZ, Jan 20–Feb 3".',
        },
      },
      required: ['test_type', 'source'],
    },
  },
];

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export function computeSignificance(args) {
  const { test_type, source } = args;
  if (!source) return { error: 'source is required for auditability' };

  if (test_type === 'ab_proportion')    return computeAbProportion(args);
  if (test_type === 'cohort_retention') return computeCohortRetention(args);
  return { error: `Unknown test_type: "${test_type}". Valid: ab_proportion, cohort_retention.` };
}

// ---------------------------------------------------------------------------
// Phase 1: ab_proportion — two-proportion z-test
// ---------------------------------------------------------------------------

function computeAbProportion(args) {
  const {
    control, variant,
    alpha = 0.05,
    direction = 'two_tailed',
    mde,
    expected_split,
    source,
  } = args;

  // Input validation
  if (!control || !variant)
    return { error: 'control and variant are required for ab_proportion' };

  const { n: n1, conversions: c1 } = control;
  const { n: n2, conversions: c2 } = variant;

  if (!Number.isInteger(n1) || n1 <= 0)  return { error: 'control.n must be a positive integer' };
  if (!Number.isInteger(n2) || n2 <= 0)  return { error: 'variant.n must be a positive integer' };
  if (!Number.isInteger(c1) || c1 < 0)  return { error: 'control.conversions must be a non-negative integer' };
  if (!Number.isInteger(c2) || c2 < 0)  return { error: 'variant.conversions must be a non-negative integer' };
  if (c1 > n1) return { error: `control.conversions (${c1}) > control.n (${n1})` };
  if (c2 > n2) return { error: `variant.conversions (${c2}) > variant.n (${n2})` };

  const p1 = c1 / n1;  // control conversion rate
  const p2 = c2 / n2;  // variant conversion rate
  const warnings = [];

  // Small-sample warnings
  if (n1 < 100) warnings.push(`control sample below threshold (n=${n1}, recommend n≥100)`);
  if (n2 < 100) warnings.push(`variant sample below threshold (n=${n2}, recommend n≥100)`);
  if (c1 < 30)  warnings.push(`control conversions below 30 (c=${c1}) — normal approximation may be unreliable; consider exact Fisher test`);
  if (c2 < 30)  warnings.push(`variant conversions below 30 (c=${c2}) — normal approximation may be unreliable; consider exact Fisher test`);

  // No variance edge case
  if (p1 === p2) {
    return {
      test_type: 'ab_proportion',
      control_rate: round(p1, 6),
      variant_rate:  round(p2, 6),
      absolute_lift: 0,
      relative_lift: 0,
      p_value: 1,
      ci_95: [0, 0],
      significant: false,
      n_control: n1,
      n_variant:  n2,
      power: null,
      underpowered: null,
      srm: { checked: false },
      warnings: ['no variance — control and variant rates are identical'],
      source,
    };
  }

  // ── Two-proportion z-test (pooled SE for hypothesis test) ──
  const pooled   = (c1 + c2) / (n1 + n2);
  const se_pool  = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z        = (p2 - p1) / se_pool;

  const pValue = direction === 'two_tailed'
    ? 2 * (1 - normCDF(Math.abs(z)))
    : 1 - normCDF(z);  // one-tailed: variant > control

  // ── 95% CI for (p2 - p1) using unpooled SE ──
  const se_unpool = Math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2);
  const z_crit    = 1.96;  // α=0.05 two-tailed
  const diff      = p2 - p1;
  const ci_95     = [
    round(diff - z_crit * se_unpool, 6),
    round(diff + z_crit * se_unpool, 6),
  ];

  const significant = pValue < alpha;

  // ── Power / sample-size check (if MDE provided) ──
  let power       = null;
  let underpowered = null;
  if (mde !== undefined) {
    // Hypothetical variant rate under the MDE
    const p2_hyp   = p1 * (1 + mde);
    const se_hyp   = Math.sqrt(p1 * (1 - p1) / n1 + p2_hyp * (1 - p2_hyp) / n2);
    const effect   = Math.abs(p2_hyp - p1);
    power          = round(normCDF(effect / se_hyp - z_crit), 4);
    underpowered   = power < 0.80;
    if (underpowered)
      warnings.push(`underpowered: achieved power=${(power * 100).toFixed(0)}% for MDE=${(mde * 100).toFixed(1)}% — increase sample size`);
  }

  // ── Sample Ratio Mismatch check (if expected_split provided) ──
  let srm = { checked: false };
  if (Array.isArray(expected_split) && expected_split.length >= 2) {
    const total   = n1 + n2;
    const exp1    = total * expected_split[0];
    const exp2    = total * expected_split[1];
    if (exp1 > 0 && exp2 > 0) {
      const chi2   = Math.pow(n1 - exp1, 2) / exp1 + Math.pow(n2 - exp2, 2) / exp2;
      const srmP   = chi2p1df(chi2);
      const flagged = srmP < 0.01;
      srm = {
        checked:  true,
        flagged,
        chi2:     round(chi2, 4),
        p_value:  round(srmP, 4),
        detail: flagged
          ? `SRM detected: observed ${n1}/${n2}, expected ${Math.round(exp1)}/${Math.round(exp2)} — experiment assignment may be biased (p=${srmP.toFixed(3)})`
          : `No SRM (p=${srmP.toFixed(3)})`,
      };
      if (flagged)
        warnings.push('⚠️ Sample Ratio Mismatch — experiment assignment appears biased; significance result may be unreliable');
    }
  }

  return {
    test_type:     'ab_proportion',
    control_rate:  round(p1, 6),
    variant_rate:  round(p2, 6),
    absolute_lift: round(diff, 6),
    relative_lift: round(diff / p1, 6),
    p_value:       round(pValue, 6),
    ci_95,
    significant,
    n_control:     n1,
    n_variant:     n2,
    power:         power !== null ? round(power, 4) : null,
    underpowered,
    srm,
    warnings,
    source,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: cohort_retention (stub — returns structured error until implemented)
// ---------------------------------------------------------------------------

function computeCohortRetention(args) {
  const { cohorts, source } = args;

  if (!Array.isArray(cohorts) || cohorts.length < 2)
    return { error: 'cohort_retention requires at least 2 cohorts' };

  // Input validation
  for (const c of cohorts) {
    if (!c.id || !Number.isInteger(c.size) || c.size <= 0)
      return { error: `Cohort "${c.id ?? '?'}" must have a positive integer size` };
    if (!Array.isArray(c.retained_by_period) || c.retained_by_period.length === 0)
      return { error: `Cohort "${c.id}" must have retained_by_period array` };
    for (const v of c.retained_by_period) {
      if (!Number.isInteger(v) || v < 0)
        return { error: `Cohort "${c.id}" retained_by_period contains invalid value: ${v}` };
    }
  }

  // Compute retention rates per cohort per period
  const cohortResults = cohorts.map(c => ({
    id:   c.id,
    size: c.size,
    retention_by_period: c.retained_by_period.map(r => round(r / c.size, 6)),
  }));

  // Pairwise z-test per period for each pair of adjacent cohorts
  const pairwise = [];
  const maxPeriods = Math.max(...cohorts.map(c => c.retained_by_period.length));

  for (let i = 0; i < cohorts.length - 1; i++) {
    const a = cohorts[i];
    const b = cohorts[i + 1];
    const periods = Math.min(a.retained_by_period.length, b.retained_by_period.length);

    for (let p = 0; p < periods; p++) {
      const c1 = a.retained_by_period[p], n1 = a.size;
      const c2 = b.retained_by_period[p], n2 = b.size;
      const r1 = c1 / n1, r2 = c2 / n2;
      const pooled = (c1 + c2) / (n1 + n2);
      const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
      const z  = se > 0 ? (r2 - r1) / se : 0;
      const pv = 2 * (1 - normCDF(Math.abs(z)));

      pairwise.push({
        a:           a.id,
        b:           b.id,
        period:      p,
        rate_a:      round(r1, 4),
        rate_b:      round(r2, 4),
        delta:       round(r2 - r1, 4),
        p_value:     round(pv, 6),
        significant: pv < 0.05,
      });
    }
  }

  return {
    test_type: 'cohort_retention',
    cohorts:   cohortResults,
    pairwise,
    warnings:  ['observational data — differences are correlational, not causal'],
    source,
  };
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function round(val, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}
