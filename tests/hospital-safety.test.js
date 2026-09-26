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
doc.fields.encounterId.value = 'E2';
const changed = new Adapter({ document: doc, verifyServerRecord: async () => record });
changed._uploadInitiated = true;
assert.equal(await changed.awaitPersisted(makeEvidence(), 25), 'UNKNOWN', 'changed encounter');

const maBADoc = hisDocument({ encounterId: '' });
maBADoc.fields.txtMaBA = { value: 'BA123' };
const guard = loadProductionDesktopModules({ document: maBADoc }).clinical;
assert.equal(guard.getClinicalContextFromDOM(() => maBADoc).valid, false, 'maBA is not encounterId');

const uploadFrame = hisDocument({ patientId: 'P1', encounterId: 'E1' });
const parent = hisDocument({ patientId: 'P2', encounterId: 'E2' });
delete parent.fields.btnUpload;
delete parent.fields.UploadController;
parent.querySelectorAll = (selector) => selector === 'iframe'
  ? [{ contentDocument: uploadFrame }] : [];
assert.equal(guard.getClinicalContextFromDOM(() => parent).valid, false,
  'parent patient and upload iframe cannot disagree');

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
