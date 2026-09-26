# CamSync 9.5 Medical-Grade Test Infrastructure (TEST_INFRA.md)

## 1. Executive Summary

This document establishes the test architecture, execution harness, feature mapping, and verification standards for the **CamSync 9.5 Medical-Grade Upgrade**.

To ensure clinical patient safety, cryptographic correctness, and zero regression risk across the 21 master features (F01–F21) specified in `PROJECT.md` and `ORIGINAL_REQUEST.md`, CamSync employs a **Requirements-Driven 4-Tier Automated E2E Testing Framework**.

All tests execute directly against **production JavaScript modules** without mock re-implementations of cryptographic algorithms, receiver state machines, clinical watermarks, or audit loggers.

---

## 2. Test Architecture & Directory Layout

### 2.1 Directory Structure
```
tests/e2e/
├── run_all_tests.js                 # Master test runner CLI (supports --tier, --verbose, --self-test)
├── harness/
│   ├── test-framework.js            # Standalone zero-dependency async test framework (describe, it, expect)
│   ├── production-loader.js         # Production module sandbox & loader (Node VM for extension, ESM for mobile)
│   ├── canvas-pixel-harness.js      # Headless Canvas 2D rasterizer & pixel inspector for watermark verification
│   ├── his-dom-harness.js           # VNPT HIS DOM tree simulator (patient banner, order grid, file input)
│   ├── mock-his-server.js           # Deterministic VNPT HIS persistence verifier (COMMITTED/REJECTED/UNKNOWN)
│   └── mock-realtime.js             # Dual-transport WebRTC/Supabase Realtime channel simulator
├── generators/
│   └── clinical-synthesizer.js      # Deterministic clinical scenario generator (ECG, Endoscopy, Ultrasound)
└── suites/
    ├── tier1-features.test.js       # Tier 1: Core Feature Coverage (F01–F21: 105 tests)
    ├── tier2-boundary.test.js       # Tier 2: Boundary & Corner Cases (B01–B21: 105 tests)
    ├── tier3-combinations.test.js   # Tier 3: Cross-Feature State Invariants (TC-C01–TC-C08: 8 tests)
    └── tier4-clinical.test.js       # Tier 4: Real-World Clinical Scenarios (TC-S01–TC-S05: 5 tests)
```

### 2.2 Production Module Sandbox Execution
To satisfy the strict constraint **"No mock re-implementations of production modules"**, the harness executes production code directly:
- **Desktop Chrome Extension Scripts** (`extension/content/`):
  - `crypto-utils.js`: Uses Node.js native `crypto.webcrypto.subtle` for AES-256-GCM.
  - `clinical-guard.js`: Loaded into a sandboxed Node VM with a synthetic `document`, `window`, and `MutationObserver` to test real DOM scraping regex and 3-checkpoint gating.
  - `transfer-receiver.js`: Evaluated in the sandbox to test the actual `UnifiedTransferReceiver` state machine, chunk reassembly, and magic byte detection.
  - `audit-logger.js`: Evaluated in the sandbox to verify zero-raw-PHI sanitization and `chrome.storage.local` ring buffer.
- **Mobile Web Application Modules** (`mobile-web/js/`):
  - `mobile-web/js/editor.js`: Imported via ES Module to execute `drawClinicalWatermark`, `calculateScaleFactor`, and `renderWatermarkCanvas` directly.
  - `mobile-web/js/p2p-client.js`: Imported via ES Module to execute actual chunking, V2 payload framing, and key scrub routines.
- **HIS Adapter Interface**:
  - `HisAdapterTestFixture`: Follows the exact TypeScript interface contract specified in `PROJECT.md § HisAdapter Interface Contract` (`readContext`, `compareContext`, `attachImage`, `beginUpload`, `awaitPersisted`).

---

## 3. 4-Tier Testing Methodology

| Tier | Name | Target Scope | Test Count | Pass Criterion |
|---|---|---|---|---|
| **Tier 1** | **Core Feature Coverage** | Features F01 to F21 (>=5 test cases per feature for representative clinical and cryptographic inputs) | **105** | 100% Pass |
| **Tier 2** | **Boundary & Corner Cases** | Edge conditions, corruptions, fuzzing, bounds, expired TTL, pixel bombs (>=5 test cases per feature) | **105** | 100% Pass, Fail-Closed |
| **Tier 3** | **Cross-Feature Combinations** | Multi-feature race conditions, context mutation during chunking, dual-tab concurrency, hybrid transport fallback | **8** | Invariants Preserved |
| **Tier 4** | **Real-World Clinical Scenarios** | End-to-end medical clinical workflows (ECG, Endoscopy, Ultrasound, Rapid Outpatient Switching, Network Drop SOP) | **5** | Zero Safety Violations |
| **Total** | | **Master CamSync 9.5 Test Suite** | **223** | **100% Pass** |

---

## 4. Master Feature Mapping Matrix (F01–F21)

Every single feature defined in `PROJECT.md § Feature Inventory` maps directly to explicit test identifiers across all four tiers:

| Feature ID | Feature Name | Tier 1 Tests (5) | Tier 2 Tests (5) | Tier 3 / Tier 4 Cross-References |
|---|---|---|---|---|
| **F01** | Immutable Desktop SessionContext | `TC-F01.1` – `TC-F01.5` | `TC-B01.1` – `TC-B01.5` | `TC-C01`, `TC-C04`, `TC-C05`, `TC-C07`, `TC-S04` |
| **F02** | Fail-Closed Context Gating | `TC-F02.1` – `TC-F02.5` | `TC-B02.1` – `TC-B02.5` | `TC-C01`, `TC-S03` |
| **F03** | Per-Tab Session Isolation | `TC-F03.1` – `TC-F03.5` | `TC-B03.1` – `TC-B03.5` | `TC-C05`, `TC-C07`, `TC-S04` |
| **F04** | 3-Checkpoint Context Barrier | `TC-F04.1` – `TC-F04.5` | `TC-B04.1` – `TC-B04.5` | `TC-C01`, `TC-C05`, `TC-S03` |
| **F05** | Safe Lifecycle Teardown & TTL | `TC-F05.1` – `TC-F05.5` | `TC-B05.1` – `TC-B05.5` | `TC-C04`, `TC-S04` |
| **F06** | Standard State Contract | `TC-F06.1` – `TC-F06.5` | `TC-B06.1` – `TC-B06.5` | `TC-C02`, `TC-C08`, `TC-S01` |
| **F07** | Ban on Speculative Success | `TC-F07.1` – `TC-F07.5` | `TC-B07.1` – `TC-B07.5` | `TC-C02`, `TC-S05` |
| **F08** | Authentic HIS Evidence Verification | `TC-F08.1` – `TC-F08.5` | `TC-B08.1` – `TC-B08.5` | `TC-C02`, `TC-C08`, `TC-S01` |
| **F09** | Deterministic HIS_UNKNOWN on Timeout/Drop | `TC-F09.1` – `TC-F09.5` | `TC-B09.1` – `TC-B09.5` | `TC-C02`, `TC-S05` |
| **F10** | Truthful Mobile Status Rendering | `TC-F10.1` – `TC-F10.5` | `TC-B10.1` – `TC-B10.5` | `TC-C02`, `TC-S01`, `TC-S05` |
| **F11** | Unified Transfer Protocol V2 | `TC-F11.1` – `TC-F11.5` | `TC-B11.1` – `TC-B11.5` | `TC-C01`, `TC-C06`, `TC-S01` |
| **F12** | AAD Metadata & Payload Privacy | `TC-F12.1` – `TC-F12.5` | `TC-B12.1` – `TC-B12.5` | `TC-C03`, `TC-S01` |
| **F13** | WebCrypto AES-256-GCM Nonce Discipline | `TC-F13.1` – `TC-F13.5` | `TC-B13.1` – `TC-B13.5` | `TC-C03`, `TC-S01` |
| **F14** | Fail-Closed Packet & Decompression Defense | `TC-F14.1` – `TC-F14.5` | `TC-B14.1` – `TC-B14.5` | `TC-C01`, `TC-S02` |
| **F15** | Private Channel Authorization | `TC-F15.1` – `TC-F15.5` | `TC-B15.1` – `TC-B15.5` | `TC-C06`, `TC-S01` |
| **F16** | Idempotent Transfer State Machine | `TC-F16.1` – `TC-F16.5` | `TC-B16.1` – `TC-B16.5` | `TC-C03`, `TC-C06`, `TC-S02` |
| **F17** | Lịch Trực Database Isolation | `TC-F17.1` – `TC-F17.5` | `TC-B17.1` – `TC-B17.5` | `TC-C08` |
| **F18** | Decoupled HisAdapter Interface | `TC-F18.1` – `TC-F18.5` | `TC-B18.1` – `TC-B18.5` | `TC-C08`, `TC-S01` |
| **F19** | Production Module Testing & Attack Matrix | `TC-F19.1` – `TC-F19.5` | `TC-B19.1` – `TC-B19.5` | `TC-C08` |
| **F20** | Sanitized Medical Audit Logger | `TC-F20.1` – `TC-F20.5` | `TC-B20.1` – `TC-B20.5` | `TC-C02`, `TC-S01`, `TC-S05` |
| **F21** | Accurate Claims & Operational SOP | `TC-F21.1` – `TC-F21.5` | `TC-B21.1` – `TC-B21.5` | `TC-S05` |

---

## 5. Test Runner Specification

The test suite is driven by `tests/e2e/run_all_tests.js` and registered in `package.json`.

### 5.1 CLI Invocations
```bash
# Run the complete 4-tier E2E test suite (223 tests)
npm run test:e2e

# Run directly via Node.js
node tests/e2e/run_all_tests.js

# Run specific tier only
node tests/e2e/run_all_tests.js --tier=1    # Runs 105 Tier 1 tests
node tests/e2e/run_all_tests.js --tier=2    # Runs 105 Tier 2 tests
node tests/e2e/run_all_tests.js --tier=3    # Runs 8 Tier 3 tests
node tests/e2e/run_all_tests.js --tier=4    # Runs 5 Tier 4 tests

# Self-test validation mode
node tests/e2e/run_all_tests.js --self-test
```

### 5.2 Performance & Execution Speed
- Total tests: 223
- Typical execution duration: **~0.10s to 0.15s** on standard developer workstation.
- Zero flaky timers; all asynchronous operations use deterministic microtask scheduling or bounded promises.

---

## 6. Coverage Thresholds & Quality Gates

| Gate Checkpoint | Milestone Milestone | Required Passing Tiers | Zero-Tolerance Safety Invariants |
|---|---|---|---|
| **Gate G0** | M2 (Honest HIS State) | Tier 1 (F01–F10, F18), Tier 2 (B01–B10, B18), Tier 3 (TC-C01, C02, C05), Tier 4 (TC-S01, S04, S05) | Never map `btnUpload.click()` to `HIS_COMMITTED`. Fail-closed on missing `encounterId`. |
| **Gate G1** | M4 (Realtime Boundary) | Tier 1 (F11–F17), Tier 2 (B11–B17), Tier 3 (TC-C03, C04, C06, C07), Tier 4 (TC-S02) | 0 DDL/DML to Lịch Trực DB (`exxynihhyvcligcysbdb`). AES-256-GCM 96-bit unique IVs. |
| **Gate G2** | M5 (Sanitized Audit & SOP) | Tier 1 (F19–F21), Tier 2 (B19–B21), Tier 3 (TC-C08), Tier 4 (TC-S01–S05) | Zero raw PHI in logs. 300ms clinical tooltip delay. Zero long tasks (>50ms). |

Every release and milestone promotion requires a **100% pass rate** (`0 failed`) across all active tiers.
