#!/usr/bin/env node
/**
 * HIS CamSync - Master Automated E2E Test Runner
 * Executes the complete 4-tier E2E testing framework:
 * - Tier 1: Core Feature Coverage (F1 - F6)
 * - Tier 2: Boundary & Corner Cases (B1 - B5)
 * - Tier 3: Cross-Feature Combinations (C1 - C8)
 * - Tier 4: Real-World Clinical Scenarios (S1 - S5)
 * 
 * Usage:
 *   node tests/e2e/run_all_tests.js
 *   node tests/e2e/run_all_tests.js --self-test
 *   node tests/e2e/run_all_tests.js --tier=1
 *   node tests/e2e/run_all_tests.js --tier=4
 */

import { globalContext, TestRunnerContext } from './harness/test-framework.js';

// Parse command line arguments
const args = process.argv.slice(2);
const isSelfTest = args.includes('--self-test');
const isVerbose = args.includes('--verbose');
const tierArg = args.find(a => a.startsWith('--tier=') || a.startsWith('-t='));
const targetTier = tierArg ? parseInt(tierArg.split('=')[1], 10) : null;

console.log('\x1b[1m\x1b[34m' + '═'.repeat(72) + '\x1b[0m');
console.log('\x1b[1m\x1b[37m  HIS CamSync — 4-Tier Automated E2E Testing Suite\x1b[0m');
console.log('\x1b[90m  Zero-Retention • Zero-Leakage • Clinical Watermark • VNPT HIS Integration\x1b[0m');
if (isSelfTest) console.log('\x1b[33m  Mode: Self-Test Validation\x1b[0m');
if (targetTier) console.log(`\x1b[35m  Target: Tier ${targetTier} only\x1b[0m`);
console.log('\x1b[1m\x1b[34m' + '═'.repeat(72) + '\x1b[0m');

async function main() {
  const runner = new TestRunnerContext();

  const suitesToLoad = [];
  if (!targetTier || targetTier === 1) suitesToLoad.push({ tier: 1, path: './suites/tier1-features.test.js' });
  if (!targetTier || targetTier === 2) suitesToLoad.push({ tier: 2, path: './suites/tier2-boundary.test.js' });
  if (!targetTier || targetTier === 3) suitesToLoad.push({ tier: 3, path: './suites/tier3-combinations.test.js' });
  if (!targetTier || targetTier === 4) suitesToLoad.push({ tier: 4, path: './suites/tier4-clinical.test.js' });

  // Dynamically load selected suites
  for (const s of suitesToLoad) {
    await import(s.path);
  }

  // Run all loaded suites through globalContext
  const stats = await globalContext.run();

  // Print final verdict banner
  if (stats.failed === 0) {
    console.log('\x1b[1m\x1b[42m\x1b[30m  ✔ ALL TEST TIERS PASSED SUCCESSFULLY  \x1b[0m\n');
    process.exit(0);
  } else {
    console.error(`\x1b[1m\x1b[41m\x1b[37m  ✖ TEST RUN FAILED: ${stats.failed} FAILING TESTS  \x1b[0m\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n\x1b[31mFatal Runner Error:\x1b[0m', err);
  process.exit(1);
});
