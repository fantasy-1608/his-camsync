# Project: HIS CamSync - Supabase Decoupling & Clinical Hardening

## Architecture
- **Supabase Infrastructure**: Dedicated project `his-camsync` in Singapore (`ap-southeast-1`) under Org `fantasy-1608's Org` (`bajkbkwoojcisknhcjze`).
  - Zero PostgreSQL database storage for medical photos (`Zero-Retention on Cloud`, RAM-to-RAM).
  - Strict isolation: Project `exxynihhyvcligcysbdb` (Lịch trực) is completely untouched.
  - Schema access: `REVOKE ALL ON SCHEMA public FROM anon, authenticated` (Zero-Leakage security).
- **Session Cryptography & Zero-PHI**:
  - 128-bit cryptographic entropy via `crypto.getRandomValues(new Uint8Array(16))`.
  - QR Code & Mobile URL pass session via hash fragment (`#session=<id>`) with immediate `history.replaceState` removal. Zero patient PHI (Name, ID, Age) in QR/URL.
- **Transport Architecture**:
  - Primary Channel: WebRTC P2P DataChannel (16KB chunking) for direct LAN/Wi-Fi transfer.
  - Cloud Relay Fallback: Supabase Realtime Channel (Broadcast mode) with 64KB chunking (`CHUNK_START`, `CHUNK_DATA`, `CHUNK_COMPLETE`, `TRANSFER_ACK`) via WebSockets.
  - Polling Elimination: 0 HTTP polling requests (complete removal of 800ms polling).
- **Clinical Watermark**:
  - Canvas injection in `mobile-web/js/editor.js` on `outCanvas` during `exportBlob()`.
  - Format: `Mã BN + Họ tên (nếu có) + Thời gian chụp (YYYY-MM-DD HH:mm:ss) + HIS CamSync`.
  - Position: Outer edge margin (bottom-right/bottom-left), semi-transparent dark capsule `rgba(15, 23, 42, 0.80)`, dynamic font scaling, never obscuring ECG P-QRS-T waveforms or ultrasound anatomy.
  - Output: 100% compliant standard JPEG JFIF blob compatible with VNPT HIS `#fileUpload`.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Supabase Project Provisioning | Create `his-camsync` project in Singapore (`ap-southeast-1`) in Org `bajkbkwoojcisknhcjze` | M1 | ORIGINAL_REQUEST §R1 |
| 2 | Zero-Leakage Schema Lockdown | Revoke public schema direct table access from `anon`/`authenticated` | M1 | ORIGINAL_REQUEST §R2 |
| 3 | Lịch Trực Database Isolation | Ensure zero DDL/DML on `exxynihhyvcligcysbdb` (`schedule_months`, `shift_requests`, etc.) | M1 | ORIGINAL_REQUEST §R1 |
| 4 | 128-bit Cryptographic Session ID | Replace `Date.now() + Math.random()` with `crypto.getRandomValues()` | M2 | ORIGINAL_REQUEST §R2 |
| 5 | Zero-PHI QR Code & Mobile URL | Eliminate patient name/ID from QR code & URL; use URL hash fragment `#session=...` + `history.replaceState` | M2 | ORIGINAL_REQUEST §R2 |
| 6 | Clinical Watermark Engine | Canvas-based clinical watermark with timestamp, patient ID/name, HIS CamSync branding | M2 | ORIGINAL_REQUEST §R4 |
| 7 | Medical Anatomy Safe Placement | Watermark placed at outer edge, semi-transparent capsule, preserving ECG P-QRS-T and ultrasound | M2 | ORIGINAL_REQUEST §R4 |
| 8 | Standard JPEG Export Compatibility | Export standard JFIF JPEG blob 100% compatible with VNPT HIS form upload | M2 | ORIGINAL_REQUEST §R4 |
| 9 | Supabase Realtime Broadcast Channel | WebSockets Broadcast channel for RAM-to-RAM relay without database persistence | M3 | ORIGINAL_REQUEST §R3 |
| 10 | 64KB Broadcast Chunking Protocol | Chunked transmission protocol (`CHUNK_START`, `CHUNK_DATA`, `CHUNK_COMPLETE`, `TRANSFER_ACK`) within 256KB limit | M3 | ORIGINAL_REQUEST §R3 |
| 11 | HTTP Polling Elimination | Eliminate 800ms desktop polling and 3.5s mobile polling entirely | M3 | ORIGINAL_REQUEST §R3 |
| 12 | WebRTC P2P Primary & Fallback Flow | Preserve WebRTC P2P DataChannel as primary LAN channel, seamless fallback to Realtime Broadcast | M3 | ORIGINAL_REQUEST §R3 |
| 13 | Lifecycle Teardown & 0% Overhead | Clean unsubscription, timer clearance, peer destruction on modal close to prevent memory leaks | M3 | ORIGINAL_REQUEST §R3, Skill |
| 14 | Chrome MV3 Host Permissions Sync | Add `https://*.supabase.co/*` and `wss://*.supabase.co/*` to `extension/manifest.json` | M3 | ORIGINAL_REQUEST §R5 |
| 15 | Documentation Sync | Update `README.md` to accurately describe Realtime Broadcast and Zero-Retention architecture | M4 | ORIGINAL_REQUEST §R5 |
| 16 | Zero Legacy Request Verification | Audit network traffic to guarantee 0 requests to `exxynihhyvcligcysbdb` | M4 | ORIGINAL_REQUEST §Acceptance |
| 17 | 4-Tier E2E Test Suite Pass | Pass 100% of E2E test suite (Tiers 1-4) | M5 | ORIGINAL_REQUEST §Acceptance |
| 18 | Adversarial Coverage Hardening | White-box stress-testing and boundary hardening (Tier 5) | M5 | Project Pattern |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Supabase Infra & Zero-Leakage Setup | Provision project `his-camsync` in Singapore (`ap-southeast-1`), configure Zero-Leakage permissions, export credentials | none | DONE (`rmbbqtuzkyxovmskhfgj`, `supabase_config.json`) |
| M2 | Session Cryptography & Clinical Watermark | Implement 128-bit Session ID, Zero-PHI in QR/URL, and Canvas Clinical Watermark in `editor.js` & `index.html` | none | DONE (`editor.js`, `index.html`, `p2p-client.js`) |
| M3 | Realtime Broadcast & Lifecycle Teardown | Implement pure Realtime Broadcast with 64KB chunking in extension & mobile-web, eliminate 800ms polling, update `manifest.json` | M1, M2 | DONE (`camsync-content.js`, `p2p-client.js`, `manifest.json`, `index.html`, `style.css`) |
| M4 | Documentation Sync & Legacy Isolation Audit | Update `README.md`, verify zero requests to old project `exxynihhyvcligcysbdb` | M3 | DONE (`README.md`, 0 legacy references) |
| M5 | Final E2E Test Pass & Hardening | Phase 1: Pass 100% of E2E test suite (Tiers 1-4). Phase 2: Adversarial coverage hardening (Tier 5). | M4, TEST_READY.md | DONE (Tiers 1-4: 63/63 passed; Tier 5: 36/36 passed; Auditor CLEAN; Reviewer APPROVE) |

## Interface Contracts
### Session & Signaling Contract
- `session_id`: 32-character hex string generated from 16 cryptographically secure random bytes (`crypto.getRandomValues(new Uint8Array(16))`).
- Mobile URL: `https://fantasy-1608.github.io/his-camsync/mobile-web/#session=<session_id>`.
  - Mobile client immediately extracts `session_id` from `window.location.hash` and calls `window.history.replaceState(null, '', window.location.pathname)`.
- Supabase Realtime Channel:
  - Channel Topic: `camsync:<session_id>`
  - Event `signal`: Peer signaling (SDP offer/answer, ICE candidates)
  - Event `session_ready`: Desktop announces ready
  - Event `chunk_start`: `{ transferId, totalChunks, totalSize, mimeType: "image/jpeg", filename }`
  - Event `chunk_data`: `{ transferId, chunkIndex, data }` (Base64 chunk up to 64KB)
  - Event `chunk_complete`: `{ transferId }`
  - Event `transfer_ack`: `{ transferId, status: "success" }`

### Clinical Watermark Contract
- Function: `editor.exportBlob(quality = 0.90, options = {})`
- Options: `{ patient: { id: string, name?: string }, timestamp?: number }`
- Watermark Text:
  - Default: `BN: <id> - <name> | <YYYY-MM-DD HH:mm:ss> | HIS CamSync`
  - When ID only: `BN: <id> | <YYYY-MM-DD HH:mm:ss> | HIS CamSync`
  - When no patient: `<YYYY-MM-DD HH:mm:ss> | HIS CamSync`
- Render target: `outCanvas` in `exportBlob()`. Output blob: MIME `image/jpeg`.

## Code Layout
- `extension/content/camsync-content.js`: HIS Desktop Extension Content Script (QR modal, Realtime Channel listener, HIS DOM injector).
- `extension/manifest.json`: Chrome Extension Manifest V3 configuration.
- `mobile-web/js/p2p-client.js`: Mobile Web Client (Realtime Broadcast publisher, WebRTC peer).
- `mobile-web/js/editor.js`: Canvas Image Editor & Clinical Watermark Engine.
- `mobile-web/index.html`: Mobile Web UI and orchestration.
- `tests/e2e/`: E2E Test Suite (Harness, runners, synthetic clinical generators).
- `README.md`: System documentation and architecture guide.
