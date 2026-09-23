#!/usr/bin/env node
/**
 * Adversarial Security Probe Suite - Supabase Zero-Leakage Verification
 * Target: his-camsync (rmbbqtuzkyxovmskhfgj)
 * 
 * Verifies that all unauthorized REST attempts against PostgREST fail-closed
 * with 401 Unauthorized or 404 Not Found (Zero-Leakage guarantee).
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.resolve(__dirname, '../supabase_config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const BASE_URL = config.supabaseUrl;
const ANON_KEY = config.anonKey;
const PUB_KEY = config.publishableKey;

function executeRequest({ method = 'GET', endpoint = '/rest/v1/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, BASE_URL);
    const reqHeaders = {
      ...headers
    };
    if (body) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const options = {
      method,
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      headers: reqHeaders
    };

    const req = https.request(options, (res) => {
      let rawData = '';
      res.on('data', chunk => { rawData += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(rawData);
        } catch (e) {
          json = rawData;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json
        });
      });
    });

    req.on('error', (err) => reject(err));
    if (body) req.write(body);
    req.end();
  });
}

const testCases = [
  {
    name: 'TC-ADV-01: Direct root query without API key',
    method: 'GET',
    endpoint: '/rest/v1/',
    headers: {},
    expectedStatus: 401,
    expectedErrorSnippet: 'No API key found in request'
  },
  {
    name: 'TC-ADV-02: Direct OpenAPI schema query with anon key',
    method: 'GET',
    endpoint: '/rest/v1/',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    expectedStatus: 401,
    expectedErrorSnippet: 'UNAUTHORIZED_INVALID_API_KEY_TYPE'
  },
  {
    name: 'TC-ADV-03: Direct OpenAPI schema query with modern publishable key',
    method: 'GET',
    endpoint: '/rest/v1/',
    headers: { apikey: PUB_KEY },
    expectedStatus: 401,
    expectedErrorSnippet: 'UNAUTHORIZED_INVALID_API_KEY_TYPE'
  },
  {
    name: 'TC-ADV-04: Unauthorized SELECT on camsync_sessions with anon key',
    method: 'GET',
    endpoint: '/rest/v1/camsync_sessions',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-05: Unauthorized SELECT on camsync_transfers with anon key',
    method: 'GET',
    endpoint: '/rest/v1/camsync_transfers',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-06: Unauthorized INSERT into camsync_sessions with anon key',
    method: 'POST',
    endpoint: '/rest/v1/camsync_sessions',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ session_id: 'adversarial_probe_1', status: 'open' }),
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-07: Unauthorized INSERT into camsync_transfers with anon key',
    method: 'POST',
    endpoint: '/rest/v1/camsync_transfers',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ session_id: 'adversarial_probe_1', image_data: 'data:image/jpeg;base64,probe' }),
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-08: Unauthorized PATCH on camsync_sessions with anon key',
    method: 'PATCH',
    endpoint: '/rest/v1/camsync_sessions?id=eq.1',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ status: 'compromised' }),
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-09: Unauthorized DELETE on camsync_sessions with anon key',
    method: 'DELETE',
    endpoint: '/rest/v1/camsync_sessions?id=eq.1',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-10: Cross-project table leak check: schedule_months with anon key',
    method: 'GET',
    endpoint: '/rest/v1/schedule_months',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-11: Cross-project table leak check: shift_requests with anon key',
    method: 'GET',
    endpoint: '/rest/v1/shift_requests',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-12: Cross-project table leak check: editor_settings with anon key',
    method: 'GET',
    endpoint: '/rest/v1/editor_settings',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-13: System catalog leak check: pg_tables with anon key',
    method: 'GET',
    endpoint: '/rest/v1/pg_tables',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-14: System catalog leak check: information_schema with anon key',
    method: 'GET',
    endpoint: '/rest/v1/information_schema',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-15: Auth table leak check: users with anon key',
    method: 'GET',
    endpoint: '/rest/v1/users',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-16: RPC function probe: version with anon key',
    method: 'POST',
    endpoint: '/rest/v1/rpc/version',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({}),
    expectedStatus: 404,
    expectedCode: 'PGRST202'
  },
  {
    name: 'TC-ADV-17: Modern publishable key probe on camsync_sessions',
    method: 'GET',
    endpoint: '/rest/v1/camsync_sessions',
    headers: { apikey: PUB_KEY },
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  },
  {
    name: 'TC-ADV-18: Modern publishable key INSERT on camsync_sessions',
    method: 'POST',
    endpoint: '/rest/v1/camsync_sessions',
    headers: { apikey: PUB_KEY },
    body: JSON.stringify({ session_id: 'pub_key_probe' }),
    expectedStatus: 404,
    expectedCode: 'PGRST205'
  }
];

async function runAdversarialProbes() {
  console.log('='.repeat(70));
  console.log('  HIS CamSync — Adversarial Security Probe Suite');
  console.log(`  Target Backend: ${BASE_URL} (${config.projectId})`);
  console.log('  Zero-Leakage & Fail-Closed Access Control Audit');
  console.log('='.repeat(70));
  console.log('');

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const tc of testCases) {
    try {
      const res = await executeRequest(tc);
      const isStatusMatch = res.statusCode === tc.expectedStatus;
      let isContentMatch = true;

      if (tc.expectedCode) {
        isContentMatch = res.body?.code === tc.expectedCode;
      }
      if (tc.expectedErrorSnippet) {
        const bodyStr = JSON.stringify(res.body);
        const headerStr = JSON.stringify(res.headers);
        isContentMatch = bodyStr.includes(tc.expectedErrorSnippet) || headerStr.includes(tc.expectedErrorSnippet);
      }

      const pass = isStatusMatch && isContentMatch;
      if (pass) {
        passed++;
        console.log(`  ✔ [PASS] ${tc.name} -> HTTP ${res.statusCode}`);
      } else {
        failed++;
        console.error(`  ✖ [FAIL] ${tc.name} -> Got HTTP ${res.statusCode}, expected ${tc.expectedStatus}`);
        console.error(`    Response Body:`, JSON.stringify(res.body));
      }

      results.push({
        testCase: tc.name,
        method: tc.method,
        endpoint: tc.endpoint,
        status: res.statusCode,
        code: res.body?.code || res.headers['sb-error-code'] || null,
        bodySnippet: JSON.stringify(res.body).slice(0, 100),
        passed: pass
      });
    } catch (err) {
      failed++;
      console.error(`  ✖ [ERROR] ${tc.name} failed with network error:`, err.message);
      results.push({
        testCase: tc.name,
        passed: false,
        error: err.message
      });
    }
  }

  console.log('\n' + '-'.repeat(70));
  console.log(`Summary: Total: ${testCases.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('-'.repeat(70));

  if (failed === 0) {
    console.log('\n  ✔ ZERO-LEAKAGE VERIFIED: All unauthorized operations rejected (401/404)\n');
  } else {
    console.error('\n  ✖ SECURITY VULNERABILITY DETECTED: Unauthorized operation permitted!\n');
    process.exit(1);
  }

  return results;
}

runAdversarialProbes().catch((err) => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
