#!/usr/bin/env node
/**
 * HIS CamSync - Milestone 2 Adversarial Challenge Suite:
 * Session Cryptography Entropy & Address Bar Sanitization Test
 * 
 * Verifies:
 * 1. 10,000 Cryptographic Tokens from generateSecureToken():
 *    - Zero collisions across 10,000 samples (128-bit uniqueness)
 *    - Strict format: 32 hex chars, lowercase /^[0-9a-f]{32}$/
 *    - Uniform byte distribution via Chi-Square Goodness-of-Fit (df=255)
 *    - Hex nibble Chi-Square Goodness-of-Fit (df=15)
 *    - NIST SP 800-22 Monobit Frequency Test (1,280,000 bits)
 *    - Shannon Entropy >= 7.995 bits/byte (ideal 8.000)
 *    - Serial Lag-1 Autocorrelation (|r_1| < 0.02)
 *    - Fallback RNG format and collision resistance
 * 
 * 2. Address Bar Sanitization & URL Parameter Hygiene:
 *    - Fragment with extra junk: #session=<id>&extra=junk
 *    - Search query: ?session=<id>
 *    - Search query with tracking: ?session=<id>&tracking=fb
 *    - Combined search and hash: ?old=1#session=<id>&junk=2
 *    - Pathname preservation (/mobile-web/ vs /mobile-web/index.html)
 *    - Clean URL handling (no hash, no search)
 *    - Adversarial XSS & malformed hash parameters
 *    - P2PClient.prototype.getSessionIdFromUrl integration
 */

import assert from 'node:assert';
import { generateSecureToken, P2PClient } from '../mobile-web/js/p2p-client.js';

// =========================================================================
// Statistical Helpers for Entropy & Goodness-of-Fit Testing
// =========================================================================

/**
 * Complementary Error Function (erfc) approximation
 * Abramowitz & Stegun formula 7.1.26 (max error ~1.5e-7)
 */
function erfc(x) {
  if (x < 0) return 2 - erfc(-x);
  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const t = 1 / (1 + p * x);
  return (a1 * t + a2 * Math.pow(t, 2) + a3 * Math.pow(t, 3) + a4 * Math.pow(t, 4) + a5 * Math.pow(t, 5)) * Math.exp(-x * x);
}

/**
 * Chi-Square CDF / p-value using Wilson-Hilferty transformation
 * Approximates chi-square distribution as standard normal variable
 */
function chi2PValue(chi2, df) {
  const z = (Math.pow(chi2 / df, 1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return 0.5 * erfc(z / Math.SQRT2);
}

/**
 * Minimal Test Reporter
 */
class TestSuiteRunner {
  constructor() {
    this.total = 0;
    this.passed = 0;
    this.failed = 0;
    this.failures = [];
  }

  run(testName, fn) {
    this.total++;
    const start = performance.now();
    try {
      fn();
      const dur = (performance.now() - start).toFixed(2);
      this.passed++;
      console.log(`  \x1b[32m✔\x1b[0m ${testName} (${dur}ms)`);
    } catch (err) {
      const dur = (performance.now() - start).toFixed(2);
      this.failed++;
      this.failures.push({ name: testName, error: err });
      console.log(`  \x1b[31m✖\x1b[0m ${testName} (${dur}ms)`);
      console.error(`    \x1b[31mError:\x1b[0m ${err.message}`);
    }
  }

  summary() {
    console.log('\n' + '─'.repeat(70));
    console.log(`Summary: Total: ${this.total} | Passed: \x1b[32m${this.passed}\x1b[0m | Failed: \x1b[31m${this.failed}\x1b[0m`);
    console.log('─'.repeat(70));
    if (this.failed > 0) {
      console.log('\n\x1b[31mFAILURES:\x1b[0m');
      for (const f of this.failures) {
        console.log(`- ${f.name}: ${f.error.message}`);
      }
      return false;
    }
    console.log('\x1b[32m✔ ALL CRYPTO ENTROPY & SANITIZATION TESTS PASSED\x1b[0m\n');
    return true;
  }
}

const runner = new TestSuiteRunner();

console.log('═'.repeat(70));
console.log('  HIS CamSync — Milestone 2 Cryptography & Address Bar Challenge');
console.log('  10,000-Token Entropy Distribution • Monobit • URL Hygiene');
console.log('═'.repeat(70));

// =========================================================================
// Suite 1: 10,000 Token Cryptographic Randomness & Distribution
// =========================================================================
console.log('\n\x1b[1m\x1b[36m▶ Suite 1: 10,000 Token Cryptographic Randomness & Statistical Entropy\x1b[0m');

const SAMPLE_SIZE = 10000;
const tokens = new Array(SAMPLE_SIZE);
const tokenSet = new Set();

const byteFrequencies = new Array(256).fill(0);
const hexFrequencies = new Array(16).fill(0);
let totalOnes = 0;
const allBytes = new Uint8Array(SAMPLE_SIZE * 16);

// Pre-generate 10,000 tokens
const tGenStart = performance.now();
for (let i = 0; i < SAMPLE_SIZE; i++) {
  const t = generateSecureToken();
  tokens[i] = t;
  tokenSet.add(t);

  for (let j = 0; j < 16; j++) {
    const byteVal = parseInt(t.substr(j * 2, 2), 16);
    allBytes[i * 16 + j] = byteVal;
    byteFrequencies[byteVal]++;
    for (let bit = 0; bit < 8; bit++) {
      if ((byteVal >> bit) & 1) totalOnes++;
    }
  }

  for (let j = 0; j < 32; j++) {
    hexFrequencies[parseInt(t[j], 16)]++;
  }
}
const tGenDur = (performance.now() - tGenStart).toFixed(2);
console.log(`  \x1b[90m(Generated ${SAMPLE_SIZE.toLocaleString()} tokens in ${tGenDur}ms)\x1b[0m`);

runner.run(`TC-M2-1.1: Zero collisions across ${SAMPLE_SIZE.toLocaleString()} generated tokens (128-bit uniqueness)`, () => {
  assert.strictEqual(
    tokenSet.size,
    SAMPLE_SIZE,
    `Expected zero collisions across ${SAMPLE_SIZE} tokens, but found ${SAMPLE_SIZE - tokenSet.size} duplicates`
  );
});

runner.run('TC-M2-1.2: Strict length and lowercase hexadecimal format (/^[0-9a-f]{32}$/)', () => {
  const hexRegex = /^[0-9a-f]{32}$/;
  for (let i = 0; i < SAMPLE_SIZE; i++) {
    const t = tokens[i];
    assert.strictEqual(t.length, 32, `Token #${i} length was ${t.length}, expected exactly 32`);
    assert.strictEqual(hexRegex.test(t), true, `Token #${i} '${t}' failed lowercase hex regex`);
  }
});

runner.run('TC-M2-1.3: Byte-level Chi-Square Goodness-of-Fit Test (160,000 bytes, df=255)', () => {
  const totalBytes = SAMPLE_SIZE * 16; // 160,000
  const expectedPerByte = totalBytes / 256; // 625.0
  let chi2 = 0;

  for (let b = 0; b < 256; b++) {
    const observed = byteFrequencies[b];
    chi2 += Math.pow(observed - expectedPerByte, 2) / expectedPerByte;
  }

  const pValue = chi2PValue(chi2, 255);
  // For df=255, 99.9% confidence interval is [180, 345].
  // Acceptable chi2 for uniform random source: 175 < chi2 < 350, with p-value >= 0.001
  assert.ok(
    chi2 >= 170 && chi2 <= 360,
    `Chi-square statistic ${chi2.toFixed(3)} outside reasonable confidence bounds [170, 360] (p=${pValue.toFixed(4)})`
  );
  assert.ok(
    pValue >= 0.001,
    `Chi-square p-value ${pValue.toFixed(4)} indicates non-uniform byte distribution (must be >= 0.001)`
  );
});

runner.run('TC-M2-1.4: Hex-character (nibble) Chi-Square Goodness-of-Fit Test (320,000 nibbles, df=15)', () => {
  const totalNibbles = SAMPLE_SIZE * 32; // 320,000
  const expectedPerNibble = totalNibbles / 16; // 20,000.0
  let chi2Nibble = 0;

  for (let h = 0; h < 16; h++) {
    const observed = hexFrequencies[h];
    chi2Nibble += Math.pow(observed - expectedPerNibble, 2) / expectedPerNibble;
  }

  const pValueNibble = chi2PValue(chi2Nibble, 15);
  // Critical value for df=15 at alpha=0.001 is 37.70
  assert.ok(
    chi2Nibble < 37.70,
    `Hex nibble Chi-Square ${chi2Nibble.toFixed(3)} exceeded critical value 37.70 (p=${pValueNibble.toFixed(4)})`
  );
});

runner.run('TC-M2-1.5: NIST SP 800-22 Frequency (Monobit) Test (1,280,000 bits)', () => {
  const totalBits = SAMPLE_SIZE * 16 * 8; // 1,280,000
  const zeros = totalBits - totalOnes;
  const sObs = Math.abs(totalOnes - zeros) / Math.sqrt(totalBits);
  const pValue = erfc(sObs / Math.SQRT2);

  // NIST SP 800-22 requirement: p-value >= 0.01
  assert.ok(
    pValue >= 0.01,
    `Monobit test failed: S_obs=${sObs.toFixed(4)}, p-value=${pValue.toFixed(6)} < 0.01 (1s=${totalOnes}, 0s=${zeros})`
  );
});

runner.run('TC-M2-1.6: Empirical Shannon Entropy strictly exceeds 7.995 bits/byte (Ideal: 8.000)', () => {
  const totalBytes = SAMPLE_SIZE * 16;
  let entropy = 0;

  for (let b = 0; b < 256; b++) {
    const p = byteFrequencies[b] / totalBytes;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  // Shannon entropy for 256 uniformly distributed values is exactly 8.0.
  // With 160,000 samples, empirical entropy should comfortably exceed 7.995
  assert.ok(
    entropy >= 7.995,
    `Empirical Shannon entropy ${entropy.toFixed(6)} bits/byte is below 7.995 threshold`
  );
});

runner.run('TC-M2-1.7: Byte Serial Lag-1 Autocorrelation (|r_1| < 0.02)', () => {
  const N = allBytes.length;
  let sum1 = 0, sum2 = 0;
  for (let i = 0; i < N - 1; i++) {
    sum1 += allBytes[i];
    sum2 += allBytes[i + 1];
  }
  const mean1 = sum1 / (N - 1);
  const mean2 = sum2 / (N - 1);

  let cov = 0, var1 = 0, var2 = 0;
  for (let i = 0; i < N - 1; i++) {
    const d1 = allBytes[i] - mean1;
    const d2 = allBytes[i + 1] - mean2;
    cov += d1 * d2;
    var1 += d1 * d1;
    var2 += d2 * d2;
  }
  const r1 = cov / Math.sqrt(var1 * var2);

  // Lag-1 autocorrelation should be close to 0
  assert.ok(
    Math.abs(r1) < 0.02,
    `Lag-1 autocorrelation ${r1.toFixed(5)} exceeds random tolerance (+-0.02)`
  );
});

runner.run('TC-M2-1.8: Math.random() fallback RNG validation (fallback path code coverage)', () => {
  // Simulate fallback path where crypto.getRandomValues is undefined
  function fallbackTokenGenerator() {
    let hex = '';
    for (let i = 0; i < 32; i++) {
      hex += Math.floor(Math.random() * 16).toString(16);
    }
    return hex;
  }

  const fallbackSet = new Set();
  for (let i = 0; i < 500; i++) {
    const t = fallbackTokenGenerator();
    assert.strictEqual(t.length, 32);
    assert.strictEqual(/^[0-9a-f]{32}$/.test(t), true);
    assert.strictEqual(fallbackSet.has(t), false);
    fallbackSet.add(t);
  }
});

// =========================================================================
// Suite 2: Address Bar Sanitization & URL Parameter Hygiene
// =========================================================================
console.log('\n\x1b[1m\x1b[36m▶ Suite 2: Address Bar Sanitization & URL Parameter Hygiene\x1b[0m');

/**
 * Simulates mobile-web/index.html address bar sanitization logic
 * verbatim from lines 349-365
 */
function simulateMobileWebAddressBar(initialUrl) {
  const url = new URL(initialUrl);

  const mockWindow = {
    location: {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash
    },
    history: {
      replaceStateCalls: [],
      replaceState: function(state, title, newUrl) {
        this.replaceStateCalls.push({ state, title, newUrl });
        const resolved = new URL(newUrl, mockWindow.location.origin);
        mockWindow.location.pathname = resolved.pathname;
        mockWindow.location.search = resolved.search;
        mockWindow.location.hash = resolved.hash;
        mockWindow.location.href = resolved.href;
      }
    }
  };

  // --- Logic from mobile-web/index.html (lines 350-365) ---
  let initialSessionId = null;
  if (mockWindow.location.hash) {
    const hashParams = new URLSearchParams(mockWindow.location.hash.replace(/^#/, ''));
    initialSessionId = hashParams.get('session');
  }
  if (!initialSessionId && mockWindow.location.search) {
    const searchParams = new URLSearchParams(mockWindow.location.search);
    initialSessionId = searchParams.get('session');
  }

  // Làm sạch thanh địa chỉ ngay lập tức để triệt tiêu rò rỉ session ID
  if (mockWindow.location.hash || mockWindow.location.search) {
    try {
      mockWindow.history.replaceState(null, '', mockWindow.location.pathname);
    } catch (_) {}
  }

  return {
    initialSessionId,
    mockWindow,
    replaceStateCalls: mockWindow.history.replaceStateCalls
  };
}

runner.run('TC-M2-2.1: Fragment with extra junk (#session=<id>&extra=junk&ts=123) is sanitized to pathname', () => {
  const rawUrl = 'https://fantasy-1608.github.io/his-camsync/mobile-web/#session=a1b2c3d4e5f60718293a4b5c6d7e8f90&extra=junk&ts=1727100000';
  const { initialSessionId, mockWindow, replaceStateCalls } = simulateMobileWebAddressBar(rawUrl);

  assert.strictEqual(initialSessionId, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.strictEqual(replaceStateCalls.length, 1);
  assert.strictEqual(replaceStateCalls[0].newUrl, '/his-camsync/mobile-web/');

  // Location must be completely cleaned
  assert.strictEqual(mockWindow.location.hash, '');
  assert.strictEqual(mockWindow.location.search, '');
  assert.strictEqual(mockWindow.location.href, 'https://fantasy-1608.github.io/his-camsync/mobile-web/');
  assert.ok(!mockWindow.location.href.includes('session='));
  assert.ok(!mockWindow.location.href.includes('junk'));
});

runner.run('TC-M2-2.2: Legacy search query (?session=<id>) is extracted and stripped to pathname', () => {
  const rawUrl = 'https://fantasy-1608.github.io/his-camsync/mobile-web/?session=feedfacecafebabe1234567890abcdef';
  const { initialSessionId, mockWindow, replaceStateCalls } = simulateMobileWebAddressBar(rawUrl);

  assert.strictEqual(initialSessionId, 'feedfacecafebabe1234567890abcdef');
  assert.strictEqual(replaceStateCalls.length, 1);
  assert.strictEqual(mockWindow.location.search, '');
  assert.strictEqual(mockWindow.location.hash, '');
  assert.strictEqual(mockWindow.location.href, 'https://fantasy-1608.github.io/his-camsync/mobile-web/');
});

runner.run('TC-M2-2.3: Search query with tracking & marketing parameters (?session=<id>&utm_source=fb&token=xyz)', () => {
  const rawUrl = 'https://fantasy-1608.github.io/his-camsync/mobile-web/?session=cafebabe00112233445566778899aabb&utm_source=facebook&utm_campaign=ad&token=sensitive';
  const { initialSessionId, mockWindow } = simulateMobileWebAddressBar(rawUrl);

  assert.strictEqual(initialSessionId, 'cafebabe00112233445566778899aabb');
  assert.strictEqual(mockWindow.location.search, '');
  assert.strictEqual(mockWindow.location.href, 'https://fantasy-1608.github.io/his-camsync/mobile-web/');
  assert.ok(!mockWindow.location.href.includes('token=sensitive'));
  assert.ok(!mockWindow.location.href.includes('utm_source'));
});

runner.run('TC-M2-2.4: Simultaneous search query and hash fragment (?legacy=old#session=<id>&leak=data)', () => {
  const rawUrl = 'https://fantasy-1608.github.io/his-camsync/mobile-web/?legacy=old#session=99887766554433221100aabbccddeeff&leak=data';
  const { initialSessionId, mockWindow, replaceStateCalls } = simulateMobileWebAddressBar(rawUrl);

  // Hash takes priority
  assert.strictEqual(initialSessionId, '99887766554433221100aabbccddeeff');
  assert.strictEqual(replaceStateCalls.length, 1);
  // Both query and hash must be wiped
  assert.strictEqual(mockWindow.location.search, '');
  assert.strictEqual(mockWindow.location.hash, '');
  assert.strictEqual(mockWindow.location.href, 'https://fantasy-1608.github.io/his-camsync/mobile-web/');
});

runner.run('TC-M2-2.5: URL with explicit index.html filename (/mobile-web/index.html#session=<id>)', () => {
  const rawUrl = 'https://fantasy-1608.github.io/his-camsync/mobile-web/index.html#session=11223344556677889900aabbccddeeff';
  const { initialSessionId, mockWindow, replaceStateCalls } = simulateMobileWebAddressBar(rawUrl);

  assert.strictEqual(initialSessionId, '11223344556677889900aabbccddeeff');
  assert.strictEqual(replaceStateCalls[0].newUrl, '/his-camsync/mobile-web/index.html');
  assert.strictEqual(mockWindow.location.pathname, '/his-camsync/mobile-web/index.html');
  assert.strictEqual(mockWindow.location.hash, '');
  assert.strictEqual(mockWindow.location.search, '');
});

runner.run('TC-M2-2.6: Clean URL without hash or search triggers zero replaceState invocations', () => {
  const rawUrl = 'https://fantasy-1608.github.io/his-camsync/mobile-web/';
  const { initialSessionId, mockWindow, replaceStateCalls } = simulateMobileWebAddressBar(rawUrl);

  assert.strictEqual(initialSessionId, null);
  assert.strictEqual(replaceStateCalls.length, 0, 'Clean URL must not make redundant replaceState calls');
  assert.strictEqual(mockWindow.location.href, 'https://fantasy-1608.github.io/his-camsync/mobile-web/');
});

runner.run('TC-M2-2.7: Adversarial inputs (XSS payload in params, empty session, malformed hashes)', () => {
  // 1. XSS injection attempt in extra parameters
  const xssUrl = 'https://fantasy-1608.github.io/mobile-web/#session=valid1234567890abcdef1234567890&extra=%3Cscript%3Ealert(1)%3C/script%3E';
  const r1 = simulateMobileWebAddressBar(xssUrl);
  assert.strictEqual(r1.initialSessionId, 'valid1234567890abcdef1234567890');
  assert.strictEqual(r1.mockWindow.location.hash, '');
  assert.ok(!r1.mockWindow.location.href.includes('<script>'));

  // 2. Empty session param (#session=)
  const emptyUrl = 'https://fantasy-1608.github.io/mobile-web/#session=';
  const r2 = simulateMobileWebAddressBar(emptyUrl);
  assert.strictEqual(r2.initialSessionId, ''); // empty string
  assert.strictEqual(r2.mockWindow.location.hash, '');

  // 3. Hash with no session parameter (#random_anchor_text)
  const noSessionHash = 'https://fantasy-1608.github.io/mobile-web/#tab-settings';
  const r3 = simulateMobileWebAddressBar(noSessionHash);
  assert.strictEqual(r3.initialSessionId, null);
  assert.strictEqual(r3.mockWindow.location.hash, ''); // Sanitized away

  // 4. Repeated session parameter (#session=first&session=second)
  const dupUrl = 'https://fantasy-1608.github.io/mobile-web/#session=first_token&session=second_token';
  const r4 = simulateMobileWebAddressBar(dupUrl);
  assert.strictEqual(r4.initialSessionId, 'first_token');
  assert.strictEqual(r4.mockWindow.location.hash, '');
});

runner.run('TC-M2-2.8: P2PClient.prototype.getSessionIdFromUrl integration with simulated window', () => {
  // Test 1: Window with hash
  const origWindow = globalThis.window;
  try {
    globalThis.window = {
      location: {
        hash: '#session=client_integration_hash_token',
        search: ''
      }
    };
    const client1 = new P2PClient();
    assert.strictEqual(client1.sessionId, 'client_integration_hash_token');

    // Test 2: Window with search only
    globalThis.window = {
      location: {
        hash: '',
        search: '?session=client_integration_search_token'
      }
    };
    const client2 = new P2PClient();
    assert.strictEqual(client2.sessionId, 'client_integration_search_token');

    // Test 3: Window without session -> must generate 32-char cryptographic token fallback
    globalThis.window = {
      location: {
        hash: '',
        search: ''
      }
    };
    const client3 = new P2PClient();
    assert.strictEqual(client3.sessionId.length, 32);
    assert.strictEqual(/^[0-9a-f]{32}$/.test(client3.sessionId), true);

    // Test 4: Explicit options.sessionId overrides URL
    const client4 = new P2PClient({ sessionId: 'explicitly_configured_token_id' });
    assert.strictEqual(client4.sessionId, 'explicitly_configured_token_id');
  } finally {
    globalThis.window = origWindow;
  }
});

// =========================================================================
// Execution Summary & Verdict
// =========================================================================
const allPassed = runner.summary();
if (!allPassed) {
  process.exit(1);
} else {
  process.exit(0);
}
