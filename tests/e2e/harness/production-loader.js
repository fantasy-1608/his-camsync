/**
 * HIS CamSync - Production Module Loader
 * 
 * Directly imports and executes the actual production modules:
 * - extension/content/crypto-utils.js
 * - extension/content/clinical-guard.js
 * - extension/content/transfer-receiver.js
 * - extension/content/audit-logger.js
 * - mobile-web/js/p2p-client.js
 * - mobile-web/js/editor.js
 * 
 * Provides deterministic, zero-mock execution of cryptographic,
 * clinical guard, transfer receiver, audit logging, and watermarking logic.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Direct imports of production mobile modules
import {
  drawClinicalWatermark,
  formatClinicalTimestamp,
  ImageEditor
} from '../../../mobile-web/js/editor.js';

import {
  generateSecureToken,
  importAesGcmKey as mobileImportAesGcmKey,
  encryptAesGcmPayload,
  uint8ToBase64,
  base64ToUint8,
  MAX_IMAGE_BYTES as MOBILE_MAX_IMAGE_BYTES,
  MAX_TOTAL_CHUNKS as MOBILE_MAX_TOTAL_CHUNKS,
  P2PClient
} from '../../../mobile-web/js/p2p-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../../');

const cryptoPath = path.resolve(ROOT_DIR, 'extension/content/crypto-utils.js');
const clinicalPath = path.resolve(ROOT_DIR, 'extension/content/clinical-guard.js');
const hisPath = path.resolve(ROOT_DIR, 'extension/content/his-adapter.js');
const transferPath = path.resolve(ROOT_DIR, 'extension/content/transfer-receiver.js');
const auditPath = path.resolve(ROOT_DIR, 'extension/content/audit-logger.js');

const cryptoCode = fs.readFileSync(cryptoPath, 'utf8');
const clinicalCode = fs.readFileSync(clinicalPath, 'utf8');
const hisCode = fs.readFileSync(hisPath, 'utf8');
const transferCode = fs.readFileSync(transferPath, 'utf8');
const auditCode = fs.readFileSync(auditPath, 'utf8');

/**
 * Loads the production desktop extension content modules into an isolated sandbox.
 * 
 * @param {object} options
 * @param {object} [options.document] - Custom mock document (defaults to minimal DOM)
 * @param {object} [options.storage] - Custom chrome.storage.local mock
 * @returns {object} Desktop environment containing production modules
 */
export function loadProductionDesktopModules(options = {}) {
  const elements = {};
  let defaultPatientText;
  if (options.patientText !== undefined) {
    defaultPatientText = options.patientText;
    const encMatch = defaultPatientText.match(/(?:Mã lượt khám|Mã vào viện|Số vào viện):\s*([A-Za-z0-9_.-]+)/i);
    const encId = options.encounterId || (encMatch ? encMatch[1] : null);
    if (encId && !elements['maLuotKham']) {
      elements['maLuotKham'] = { value: encId };
    }
  } else {
    defaultPatientText = 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Mã lượt khám: LK889900 - Tuổi: 45';
    if (!elements['maLuotKham']) {
      elements['maLuotKham'] = { value: options.encounterId || 'LK889900' };
    }
  }
  if (options.orderId) elements['orderId'] = { value: options.orderId };

  const mockStorageStore = options.storageStore || {};

  const mockChrome = {
    storage: {
      local: {
        get: (key, cb) => {
          const res = {};
          if (typeof key === 'string') {
            res[key] = mockStorageStore[key] || null;
          } else if (Array.isArray(key)) {
            key.forEach(k => { res[k] = mockStorageStore[k] || null; });
          } else {
            Object.assign(res, mockStorageStore);
          }
          cb(res);
        },
        set: (items, cb) => {
          Object.assign(mockStorageStore, items);
          if (cb) cb();
        },
        remove: (key, cb) => {
          if (typeof key === 'string') {
            delete mockStorageStore[key];
          } else if (Array.isArray(key)) {
            key.forEach(k => { delete mockStorageStore[k]; });
          }
          if (cb) cb();
        },
        clear: (cb) => {
          for (const k of Object.keys(mockStorageStore)) {
            delete mockStorageStore[k];
          }
          if (cb) cb();
        }
      }
    }
  };

  const doc = options.document || {
    readyState: 'complete',
    body: { innerText: defaultPatientText },
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
      if (sel === '#patientBanner' || sel === '#thongtinbenhnhan' || sel === '#patientInfo' || sel === '#grdBenhNhan') {
        return elements['patientBanner'] || elements['patientInfo'] || { innerText: defaultPatientText };
      }
      return null;
    },
    querySelectorAll: () => []
  };

  const sandbox = {
    document: doc,
    chrome: mockChrome,
    crypto: crypto.webcrypto,
    TextEncoder,
    TextDecoder,
    location: { pathname: '/vnpt-his/emr', href: 'http://his.local/emr' },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(cryptoCode, context);
  vm.runInContext(clinicalCode, context);
  vm.runInContext(hisCode, context);
  vm.runInContext(transferCode, context);
  vm.runInContext(auditCode, context);

  return {
    context,
    crypto: sandbox.__CamSyncCrypto,
    clinical: sandbox.__CamSyncClinical,
    his: sandbox.__CamSyncHis,
    hisAdapter: sandbox.__CamSyncHisAdapter,
    transfer: sandbox.__CamSyncTransfer,
    audit: sandbox.__CamSyncAudit,
    mockStorageStore,
    document: doc,
    elements
  };
}

/**
 * Creates a reference implementation of HisAdapter adhering strictly to
 * the interface contract defined in PROJECT.md § Interface Contracts.
 */
export function createMockHisAdapter(options = {}) {
  let currentContext = options.initialContext !== undefined ? options.initialContext : {
    patientId: '24089123',
    encounterId: 'ENC_2026_01',
    orderId: 'ORD_9981',
    patientName: 'NGUYEN VAN TIEN',
    patientAge: '45'
  };

  let attachedFiles = [];
  let uploadInitiated = false;
  let persistedEvidence = new Map(); // transferId -> evidence
  let simulateFailure = options.simulateFailure || null; // 'REJECTED' | 'TIMEOUT' | 'UNKNOWN'

  return {
    getContext: () => currentContext,
    setContext: (ctx) => { currentContext = ctx; },
    getAttachedFiles: () => attachedFiles,
    isUploadInitiated: () => uploadInitiated,
    clear: () => {
      attachedFiles = [];
      uploadInitiated = false;
      persistedEvidence.clear();
    },

    async readContext() {
      if (!currentContext || !currentContext.patientId || !currentContext.encounterId) {
        return null;
      }
      return { ...currentContext };
    },

    async compareContext(expected) {
      if (!currentContext || !expected) return false;
      if (currentContext.patientId !== expected.patientId) return false;
      if (currentContext.encounterId !== expected.encounterId) return false;
      if (expected.orderId && currentContext.orderId && currentContext.orderId !== expected.orderId) return false;
      return true;
    },

    async attachImage(file) {
      if (!file) return { success: false, error: 'NO_FILE_PROVIDED' };
      if (!file.name || typeof file.size !== 'number') return { success: false, error: 'INVALID_FILE_OBJECT' };
      attachedFiles.push(file);
      return { success: true };
    },

    async beginUpload() {
      if (attachedFiles.length === 0) {
        return { initiated: false, error: 'NO_FILE_ATTACHED' };
      }
      uploadInitiated = true;
      return { initiated: true };
    },

    async awaitPersisted(evidence, timeoutMs = 15000) {
      if (simulateFailure === 'REJECTED') return 'REJECTED';
      if (simulateFailure === 'TIMEOUT' || simulateFailure === 'UNKNOWN') return 'UNKNOWN';

      if (!uploadInitiated) return 'UNKNOWN';
      if (!evidence || !evidence.transferId) return 'UNKNOWN';
      if (!evidence.expectedContext || !evidence.expectedContext.patientId) return 'UNKNOWN';

      // Context validation barrier
      if (currentContext.patientId !== evidence.expectedContext.patientId ||
          currentContext.encounterId !== evidence.expectedContext.encounterId) {
        return 'UNKNOWN';
      }

      persistedEvidence.set(evidence.transferId, {
        ...evidence,
        savedAt: Date.now()
      });

      return 'COMMITTED';
    }
  };
}

/**
 * Creates authenticated AES-256-GCM ciphertext with AAD metadata header.
 */
export async function createAuthenticatedPayload(cryptoKey, plaintextString, metadataHeader) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const plaintextBytes = new TextEncoder().encode(plaintextString);
  const aadBytes = new TextEncoder().encode(JSON.stringify(metadataHeader));

  const ciphertextBuf = await crypto.webcrypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aadBytes
    },
    cryptoKey,
    plaintextBytes
  );

  return {
    ivBase64: Buffer.from(iv).toString('base64'),
    ciphertextBase64: Buffer.from(ciphertextBuf).toString('base64'),
    aad: metadataHeader
  };
}

/**
 * Decrypts authenticated AES-256-GCM ciphertext with AAD metadata header.
 */
export async function decryptAuthenticatedPayload(cryptoKey, ivBase64, ciphertextBase64, metadataHeader) {
  const iv = Buffer.from(ivBase64, 'base64');
  const ciphertext = Buffer.from(ciphertextBase64, 'base64');
  const aadBytes = new TextEncoder().encode(JSON.stringify(metadataHeader));

  const decryptedBuf = await crypto.webcrypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aadBytes
    },
    cryptoKey,
    ciphertext
  );

  return new TextDecoder().decode(decryptedBuf);
}

// Re-export production modules
export {
  drawClinicalWatermark,
  formatClinicalTimestamp,
  ImageEditor,
  generateSecureToken,
  mobileImportAesGcmKey,
  encryptAesGcmPayload,
  uint8ToBase64,
  base64ToUint8,
  MOBILE_MAX_IMAGE_BYTES,
  MOBILE_MAX_TOTAL_CHUNKS,
  P2PClient
};
