#!/usr/bin/env node
/**
 * HIS CamSync — Master 10-Tier Hardening & Quality Assurance Runner
 * Runs the comprehensive regression suite covering all 10 tiers:
 * - Tiers 1-4: Core features, boundaries, combinations, clinical scenarios
 * - Tier 5: Adversarial fault injection & bounds fuzzing
 * - Tier 6: Clinical safety & patient context invariants (Checkpoint 1-4)
 * - Tier 7: Dual transport receiver parity (WebRTC <-> Supabase Realtime)
 * - Tier 8: Strict ACK semantics & deterministic DOM writeback
 * - Tier 9: End-to-end encryption (WebCrypto AES-GCM 256-bit zero-knowledge)
 * - Tier 10: Reconnection backoff, offline resiliency & memory hygiene
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const TIERS = [
  { name: 'Tiers 1-4: Core E2E Verification Suites (63 Checks)', file: 'tests/e2e/run_all_tests.js' },
  { name: 'Tier 5: Adversarial Stress & Bounds Fuzzing (36 Checks)', file: 'tests/m5_adversarial_tier5_suite.js' },
  { name: 'Tier 6: Clinical Safety & Context Invariants (9 Checks)', file: 'tests/m6_clinical_safety_tier6_suite.js' },
  { name: 'Tier 7: Dual Transport Parity & Receiver Hardening (19 Checks)', file: 'tests/m7_transport_parity_tier7_suite.js' },
  { name: 'Tier 8: Strict ACK Semantics & Writeback Safety (13 Checks)', file: 'tests/m8_ack_semantics_tier8_suite.js' },
  { name: 'Tier 9: E2EE WebCrypto AES-GCM 256-bit Security (14 Checks)', file: 'tests/m9_e2ee_tier9_suite.js' },
  { name: 'Tier 10: Reconnection, Offline Resiliency & Hygiene (11 Checks)', file: 'tests/m10_reconnect_tier10_suite.js' }
];

async function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: rootDir, stdio: 'inherit' });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Exit code ${code}`));
    });
    p.on('error', reject);
  });
}

async function runAll() {
  const startTime = Date.now();
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(74) + '\x1b[0m');
  console.log('\x1b[1m\x1b[37m  HIS CamSync — Complete 10-Tier Hardening & Quality Assurance\x1b[0m');
  console.log('\x1b[90m  165 Automated Checks • Zero-Retention • Zero-Knowledge • E2EE AES-GCM\x1b[0m');
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(74) + '\x1b[0m\n');

  let passedTiers = 0;

  for (let i = 0; i < TIERS.length; i++) {
    const tier = TIERS[i];
    console.log(`\x1b[1m\x1b[33m>>> Running [${i + 1}/${TIERS.length}]: ${tier.name}\x1b[0m`);
    try {
      await runCommand(process.execPath, [path.resolve(rootDir, tier.file)]);
      passedTiers++;
      console.log(`\x1b[32m✔ [${i + 1}/${TIERS.length}] ${tier.name} PASSED\x1b[0m\n`);
    } catch (err) {
      console.error(`\x1b[31m✖ [${i + 1}/${TIERS.length}] ${tier.name} FAILED: ${err.message}\x1b[0m\n`);
      process.exit(1);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(74) + '\x1b[0m');
  console.log('\x1b[1m\x1b[32m  ✔ ALL 10 TIERS PASSED SUCCESSFULLY (165/165 CHECKS VERIFIED)  \x1b[0m');
  console.log(`\x1b[90m  Total Execution Time: ${duration}s across all suites\x1b[0m`);
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(74) + '\x1b[0m\n');
}

runAll().catch(err => {
  console.error('\x1b[31mMaster Test Runner Error:\x1b[0m', err);
  process.exit(1);
});
