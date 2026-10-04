import assert from 'node:assert/strict';
import { loadProductionDesktopModules } from './e2e/harness/production-loader.js';

function hisDocument({ patientId = 'P1', encounterId = 'E1', orderId = 'O1', preview = '' } = {}) {
  const fields = {
    patientId: { value: patientId }, encounterId: { value: encounterId },
    orderId: { value: orderId }, btnUpload: { disabled: false },
    UploadController: {}, fileUpload: { disabled: false, files: [] }
  };
  return {
    body: { innerText: '' },
    getElementById: (id) => fields[id] || null,
    querySelectorAll: (selector) => selector === '#list' ? [{ innerHTML: preview, textContent: preview }] : [],
    fields
  };
}

const makeEvidence = () => ({
  transferId: 'TX1', fileToken: 'ECG_TX1.jpg',
  expectedContext: { patientId: 'P1', encounterId: 'E1', orderId: 'O1' }
});

const doc = hisDocument({ preview: 'ECG_TX1.jpg' });
const desktop = loadProductionDesktopModules({ document: doc });
const Adapter = desktop.hisAdapter;
const adapter = new Adapter({ document: doc });
adapter._uploadInitiated = true;
assert.equal(await adapter.awaitPersisted(makeEvidence(), 25), 'UNKNOWN', 'DOM preview is not persistence');
doc.__simulatePersistenceCommit = true;
assert.equal(await adapter.awaitPersisted({ ...makeEvidence(), simulateCommit: true }, 25), 'UNKNOWN', 'test flags cannot commit in production');

const record = {
  source: 'HIS_SERVER', status: 'COMMITTED', transferId: 'TX1',
  fileId: 'FILE-01', fileToken: 'ECG_TX1.jpg', patientId: 'P1', encounterId: 'E1', orderId: 'O1'
};
for (const wrong of [
  { fileId: '' }, { patientId: 'P2' }, { encounterId: 'E2' },
  { orderId: 'O2' }, { transferId: 'TX2' }, { fileToken: 'other.jpg' },
  { source: 'DOM_PREVIEW' }, { status: 'PENDING' }
]) {
  const verifier = new Adapter({ document: doc, verifyServerRecord: async () => ({ ...record, ...wrong }) });
  verifier._uploadInitiated = true;
  assert.equal(await verifier.awaitPersisted(makeEvidence(), 25), 'UNKNOWN', `invalid readback ${JSON.stringify(wrong)}`);
}
const verified = new Adapter({ document: doc, verifyServerRecord: async () => record });
verified._uploadInitiated = true;
assert.equal(await verified.awaitPersisted(makeEvidence(), 25), 'COMMITTED', 'matching server record');
// Rejections need authentic transfer/context correlation, not a persisted file ID.
const rejection = { ...record, status: 'REJECTED' };
delete rejection.fileId;
delete rejection.fileToken;
for (const [overrides, result] of [
  [{}, 'REJECTED'], [{ source: 'DOM_PREVIEW' }, 'UNKNOWN'],
  [{ transferId: 'TX2' }, 'UNKNOWN'], [{ patientId: 'P2' }, 'UNKNOWN'],
  [{ encounterId: 'E2' }, 'UNKNOWN'], [{ orderId: 'O2' }, 'UNKNOWN']
]) {
  const rejecting = new Adapter({ document: doc,
    verifyServerRecord: async () => ({ ...rejection, ...overrides }) });
  rejecting._uploadInitiated = true;
  assert.equal(await rejecting.awaitPersisted(makeEvidence(), 100), result);
}

// Cache is reusable only for the same authenticated transfer/token/context.
let calls = 0;
const cachedAdapter = new Adapter({ document: doc, verifyServerRecord: async () => {
  calls++;
  return calls === 1 ? record : null;
} });
cachedAdapter._uploadInitiated = true;
assert.equal(await cachedAdapter.awaitPersisted(makeEvidence(), 100), 'COMMITTED');
assert.equal(await cachedAdapter.awaitPersisted(makeEvidence(), 100), 'COMMITTED');
assert.equal(calls, 1, 'repeat must not invoke verifier');
assert.equal(await cachedAdapter.awaitPersisted({ ...makeEvidence(), fileToken: 'other.jpg' }, 100), 'UNKNOWN');
assert.equal(calls, 2, 'different token must not reuse evidence');
doc.fields.orderId.value = 'O2';
assert.equal(await cachedAdapter.awaitPersisted({ ...makeEvidence(),
  expectedContext: { patientId: 'P1', encounterId: 'E1', orderId: 'O2' } }, 100), 'UNKNOWN');
assert.equal(calls, 3, 'different order must not reuse evidence');
doc.fields.orderId.value = 'O1';
doc.fields.encounterId.value = 'E2';
assert.equal(await cachedAdapter.awaitPersisted(makeEvidence(), 100), 'UNKNOWN');
assert.equal(calls, 3, 'live context gate precedes cached result');
doc.fields.encounterId.value = 'E1';
cachedAdapter.cleanup();
cachedAdapter._uploadInitiated = true;
assert.equal(await cachedAdapter.awaitPersisted(makeEvidence(), 100), 'UNKNOWN');
assert.equal(calls, 4, 'cleanup clears cached evidence');

// Session teardown resolves waiters even if a verifier ignores AbortSignal.
for (const method of ['cleanup', 'destroy']) {
  let complete;
  let signal;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pendingAdapter = new Adapter({ document: doc, verifyServerRecord: args => {
    signal = args.signal;
    started();
    return new Promise(resolve => { complete = resolve; });
  } });
  pendingAdapter._uploadInitiated = true;
  const pending = pendingAdapter.awaitPersisted(makeEvidence(), 1000);
  await ready;
  assert.equal(pendingAdapter._pendingPersistResolvers.size, 1);
  pendingAdapter[method]('COMMITTED');
  assert.equal(signal.aborted, true);
  let watchdog;
  try {
    assert.equal(await Promise.race([pending, new Promise(resolve => {
      watchdog = setTimeout(() => resolve('NOT_CANCELLED'), 100);
    })]), 'UNKNOWN', `${method} promptly cancels verifier`);
  } finally { clearTimeout(watchdog); }
  complete(record);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pendingAdapter._persistedEvidence.size, 0, 'late commit cannot restore evidence');
  assert.equal(pendingAdapter._pendingPersistResolvers.size, 0);
}
const racingAdapter = new Adapter({ document: doc, verifyServerRecord: async () => record });
racingAdapter._uploadInitiated = true;
const racing = racingAdapter.awaitPersisted(makeEvidence(), 100);
racingAdapter.cleanup();
assert.equal(await racing, 'UNKNOWN', 'cleanup during initial context read invalidates operation');

doc.fields.encounterId.value = 'E2';
const changed = new Adapter({ document: doc, verifyServerRecord: async () => record });
changed._uploadInitiated = true;
assert.equal(await changed.awaitPersisted(makeEvidence(), 25), 'UNKNOWN', 'changed encounter');

const maBADoc = hisDocument({ encounterId: '' });
maBADoc.fields.txtMaBA = { value: 'BA123' };
const guard = loadProductionDesktopModules({ document: maBADoc }).clinical;
assert.equal(guard.getClinicalContextFromDOM(() => maBADoc).valid, false, 'maBA is not encounterId');

// VNPT HIS CLS (CDHA / MauBenhPham) encounter resolution verification
const clsDoc = hisDocument({ encounterId: '', orderId: '' });
clsDoc.fields.hdfIDMauBenhPham = { value: '13417333' };
clsDoc.fields.hdfSoPhieu = { value: '260926899749' };
const clsContext = guard.getClinicalContextFromDOM(() => clsDoc);
assert.equal(clsContext.valid, true, 'VNPT HIS CLS specimen ID is accepted as clinical encounter context');
assert.equal(clsContext.encounter.id, '13417333');
assert.equal(clsContext.encounter.orderId, '260926899749');

const uploadFrame = hisDocument({ patientId: 'P1', encounterId: 'E1' });
const parent = hisDocument({ patientId: 'P2', encounterId: 'E2' });
delete parent.fields.btnUpload;
delete parent.fields.UploadController;
parent.querySelectorAll = (selector) => selector === 'iframe'
  ? [{ contentDocument: uploadFrame }] : [];
assert.equal(guard.getClinicalContextFromDOM(() => parent).valid, false,
  'parent patient and upload iframe cannot disagree');

// HIS retains old upload dialogs in hidden module frames. They must not block
// the current form, while a visible/unknown conflicting form must still stop QR.
const currentForm = hisDocument();
const staleForm = hisDocument({ patientId: 'P2', encounterId: 'E2', orderId: 'O2' });
const hiddenFrame = { contentDocument: staleForm, hidden: true };
currentForm.querySelectorAll = selector => selector === 'iframe' ? [hiddenFrame] : [];
assert.equal(guard.getClinicalContextFromDOM(() => currentForm).valid, true, 'hidden stale frame does not block QR');
hiddenFrame.hidden = false;
assert.equal(guard.getClinicalContextFromDOM(() => currentForm).valid, false, 'visible/unknown conflicting frame blocks QR');
for (const state of [
  { style: { display: 'none' } },
  { style: { visibility: 'hidden' } },
  { getAttribute: name => name === 'aria-hidden' ? 'true' : null },
  { tagName: 'DIALOG', open: false }
]) {
  hiddenFrame.parentElement = state;
  assert.equal(guard.getClinicalContextFromDOM(() => currentForm).valid, true, 'hidden ancestor excludes its iframe');
}
hiddenFrame.parentElement = { style: { display: 'block' } };
assert.equal(guard.getClinicalContextFromDOM(() => currentForm).valid, false, 'reopened conflicting dialog blocks QR again');
hiddenFrame.parentElement = null;
hiddenFrame.ownerDocument = { defaultView: { getComputedStyle: () => ({ display: 'none' }) } };
assert.equal(guard.getClinicalContextFromDOM(() => currentForm).valid, true, 'CSS-hidden iframe is excluded');
hiddenFrame.ownerDocument.defaultView.getComputedStyle = () => { throw new Error('visibility unavailable'); };
assert.equal(guard.getClinicalContextFromDOM(() => currentForm).valid, false, 'unreadable visibility does not bypass conflict');
currentForm.querySelectorAll = () => [];
assert.equal(guard.getClinicalContextFromDOM(() => currentForm).valid, true);

// VNPT HIS QLBA (BenhAn / PhieuScan) nested iframe context inheritance verification
const baParentDoc = {
  body: { innerText: '' },
  fields: {
    hidMABENHNHAN: { value: '25046905' },
    hidKHAMBENHID: { value: '1779332' },
    lblTENBENHNHAN: { innerText: 'NGUYỄN THỊ THÚY HẰNG' }
  },
  getElementById: function (id) { return this.fields[id] || null; }
};
const phieuScanChildDoc = {
  body: { innerText: '' },
  fields: {
    txtSOPHIEU: { value: 'SCAN.260928.1' },
    fileUpload: { disabled: false, files: [] },
    btnCamSyncPhieuScan: {},
    btnLuu: {}
  },
  defaultView: {
    parent: {
      document: baParentDoc
    }
  },
  getElementById: function (id) { return this.fields[id] || null; }
};
baParentDoc.querySelectorAll = (selector) => selector === 'iframe'
  ? [{ contentDocument: phieuScanChildDoc }] : [];
phieuScanChildDoc.querySelectorAll = () => [];

const qlbaContext = guard.getClinicalContextFromDOM(() => baParentDoc);
assert.equal(qlbaContext.valid, true, 'QLBA Phieu Scan inherits patient and encounter from parent dialog');
assert.equal(qlbaContext.patient.id, '25046905', 'QLBA patientId correctly inherited');
assert.equal(qlbaContext.encounter.id, '1779332', 'QLBA encounterId correctly inherited');
assert.equal(qlbaContext.encounter.orderId, 'SCAN.260928.1', 'QLBA orderId correctly captured from txtSOPHIEU');
assert.equal(qlbaContext.patient.name, 'NGUYỄN THỊ THÚY HẰNG', 'QLBA patient name correctly inherited');

await desktop.audit.clear();
await desktop.audit.log('HIS_UNKNOWN', {
  sid: 'raw-session', patientRef: 'P***1', filename: 'ECG_P1.jpg',
  reason: 'Patient P1', payload: { image: 'base64' }, status: 'HIS_UNKNOWN', count: 1
});
const [entry] = await desktop.audit.getEntries();
assert.equal(entry.ev, 'HIS_UNKNOWN');
assert.equal(entry.status, 'HIS_UNKNOWN');
assert.equal(entry.count, 1);
for (const key of ['sid', 'patientRef', 'filename', 'reason', 'payload']) {
  assert.equal(entry[key], undefined, `${key} cannot be logged`);
}

console.log('Hospital safety production-module checks passed');
