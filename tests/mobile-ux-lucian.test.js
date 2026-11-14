import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const htmlPath = path.join(rootDir, 'mobile-web/index.html');
const cssPath = path.join(rootDir, 'mobile-web/css/style.css');

const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');

test('mobile inline ES module script passes strict syntax check', () => {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, 'Expected inline <script type="module"> in mobile-web/index.html');
  execFileSync(process.execPath, ['--input-type=module', '--check'], {
    input: match[1],
    stdio: 'pipe',
  });
});

test('mobile UI preserves strict self-only CSP and zero external assets', () => {
  assert.match(html, /Content-Security-Policy/i);
  assert.match(html, /default-src 'self'/);
  assert.doesNotMatch(html, /https?:\/\/fonts\.googleapis\.com/i);
  assert.doesNotMatch(css, /@import\s+url\(/i);
});

test('Quiet Clinical Utility GPU safety: zero backdrop-filter blur and reduced-motion clamp', () => {
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(
    cssWithoutComments,
    /backdrop-filter\s*:\s*blur/i,
    'mobile-web/css/style.css must not use GPU-heavy backdrop-filter: blur'
  );
  assert.match(cssWithoutComments, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
});

test('3-mode segmented bar stays CSS grid and never clobbers spring direction class', () => {
  assert.match(css, /\.specialty-segmented-bar\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(3,\s*1fr\);/);
  assert.doesNotMatch(
    html,
    /globalSpecialtyBar\.style\.display\s*=\s*['"]flex['"]/,
    'JS must not override CSS grid on globalSpecialtyBar with display = "flex"'
  );
  assert.match(
    html,
    /if\s*\(!wasEditing\)\s*return;/,
    'exitEditOverlay must bail out when not editing so go-r/go-l spring transition is not wiped'
  );
  assert.match(
    html,
    /new ResizeObserver\(/,
    'ResizeObserver must keep segmented pill coordinates synced when sibling counter changes width'
  );
});

test('document thumbnail delete button is unclipped and protected by 4s Undo without Blob leaks', () => {
  assert.match(css, /\.doc-thumb-item\s*\{[\s\S]*?overflow:\s*visible;/);
  assert.match(css, /\.doc-thumb-media\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(html, /<div class="doc-thumb-media">[\s\S]*?<\/div>\s*<button type="button" class="doc-thumb-remove"/);
  assert.match(html, /id="docUndoSnack"/);
  assert.match(html, /function commitPendingDocUndo\(\)/);
  assert.match(html, /function restoreDeletedDocPage\(\)/);
});

test('upload progress ring & checkmark strictly fail-closed on HIS_UNKNOWN and errors', () => {
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

  // Must keep legacy + clinical fail-closed guards in both JPEG and PDF send handlers
  const failGuards = script.match(/if\s*\(!res\s*\|\|\s*!res\.success\)/g) || [];
  assert.ok(failGuards.length >= 2, 'Both JPEG and PDF upload flows must guard if (!res || !res.success)');

  const fileReadyGuards = script.match(/if\s*\(res\.status\s*!==\s*'FILE_READY'\)/g) || [];
  assert.ok(fileReadyGuards.length >= 2, 'Both JPEG and PDF upload flows must guard res.status !== FILE_READY');

  // Step 3 ("Đã gắn file") only activates when isSuccess is true
  assert.match(script, /uploadStep3\.classList\.toggle\('on',\s*Boolean\(isSuccess\)\)/);

  // Error and HIS_UNKNOWN branches must strip .is-ok
  const stripOkCount = (script.match(/uploadProgressCard\?\.classList\.remove\('is-ok'\)/g) || []).length;
  assert.ok(stripOkCount >= 6, 'All non-success and cleanup paths must strip .is-ok from uploadProgressCard');
});

test('no implementation notes or developer jargon leaked into visible HTML copy', () => {
  const htmlWithoutScriptsOrComments = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const bannedLeaks = [
    /real-time synced/i,
    /không cần reload/i,
    /đã đồng bộ storage/i,
    /Lucian\s*#\d+/i,
    /\bGPU\b/i,
    /\bjsPDF\b/i,
    /\bcloud\b/i,
    /ngân sách/i,
    /định danh thế hệ/i,
  ];
  for (const pattern of bannedLeaks) {
    assert.doesNotMatch(htmlWithoutScriptsOrComments, pattern);
  }

  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const userMessages = [...script.matchAll(/(?:showErrorBanner|showWarningBanner|showToast|updateUploadModal|openHisConfirmModal)\(([\s\S]*?)\);/g)]
    .map((m) => m[1])
    .join('\n');
  for (const pattern of bannedLeaks) {
    assert.doesNotMatch(userMessages, pattern);
  }
});

test('CSS preserves DESIGN.md Teal palette, Dark Mode accent contrast, amber warning buttons, compact patient card, and valid custom properties', () => {
  assert.match(css, /:root\s*\{[\s\S]*?--accent-blue:\s*#087f8c;/);
  assert.match(css, /:root\s*\{[\s\S]*?--accent-fg:\s*#0f766e;/);
  assert.match(css, /@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{[\s\S]*?--accent-fg:\s*#2dd4bf;/);

  assert.match(css, /\.btn-action-primary\.is-amber-warning/);
  assert.match(css, /\.btn-doc-send-pdf\.is-amber-warning/);
  assert.match(css, /\.btn-doc-modal-send\.is-amber-warning/);

  assert.match(css, /\.loading-overlay\s*\{[^}]*flex-direction:\s*column;/);
  assert.match(
    css,
    /\.patient-context-card\.is-compact\s+\.patient-meta-row\s*\{\s*display:\s*none;\s*\}/,
    'is-compact must hide .patient-meta-row directly instead of relying on :empty with child span'
  );
  assert.match(css, /\.doc-size-warn-btn\s*\{[^}]*max-width:\s*calc\(100%\s*-\s*24px\);/);
  assert.match(css, /\.doc-size-warn-btn\s*\{[^}]*white-space:\s*normal;/);

  const definedVars = new Set([...css.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)].map((m) => `--${m[1]}`));
  const usedVars = new Set([...(`${css}\n${html}`).matchAll(/var\((--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
  const runtimeDynamicVars = new Set(['--dx', '--l', '--p', '--r', '--toast-left', '--undo-left']);
  const undefinedVars = [...usedVars].filter((name) => !definedVars.has(name) && !runtimeDynamicVars.has(name));
  assert.deepEqual(undefinedVars, [], `Undefined CSS variables found: ${undefinedVars.join(', ')}`);
});

test('editor.js rotate90 rotates normCrop directly instead of resetting via setCropPreset', async () => {
  const editorPath = path.join(rootDir, 'mobile-web/js/editor.js');
  const editorSrc = fs.readFileSync(editorPath, 'utf8');
  const rotateBlock = editorSrc.match(/rotate90\(degrees\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(rotateBlock, 'Expected rotate90(degrees) method in editor.js');
  assert.doesNotMatch(rotateBlock[0], /setCropPreset\(/, 'rotate90 must not reset crop with setCropPreset');

  const { ImageEditor } = await import('../mobile-web/js/editor.js');
  let presetResetCalls = 0;
  let editKinds = [];
  const mockEditor = {
    rotation90: 0,
    fineAngle: 0,
    rotation: 0,
    currentPreset: 'ecg-strip',
    normCrop: { left: 0.1, top: 0.2, right: 0.8, bottom: 0.6 },
    cropBox: null,
    container: null,
    originalImage: null,
    setCropPreset() { presetResetCalls++; },
    updateCropBoxUI: ImageEditor.prototype.updateCropBoxUI,
    render() {},
    notifyEditChange(kind) { editKinds.push(kind); },
  };

  const rot90 = ImageEditor.prototype.rotate90.call(mockEditor, 90);
  assert.equal(rot90, 90);
  assert.equal(presetResetCalls, 0);
  assert.deepEqual(editKinds, ['rotate']);
  assert.ok(Math.abs(mockEditor.normCrop.left - 0.4) < 1e-9);
  assert.ok(Math.abs(mockEditor.normCrop.top - 0.1) < 1e-9);
  assert.ok(Math.abs(mockEditor.normCrop.right - 0.8) < 1e-9);
  assert.ok(Math.abs(mockEditor.normCrop.bottom - 0.8) < 1e-9);

  ImageEditor.prototype.rotate90.call(mockEditor, -90);
  assert.equal(mockEditor.rotation90, 0);
  assert.ok(Math.abs(mockEditor.normCrop.left - 0.1) < 1e-9);
  assert.ok(Math.abs(mockEditor.normCrop.top - 0.2) < 1e-9);
  assert.ok(Math.abs(mockEditor.normCrop.right - 0.8) < 1e-9);
  assert.ok(Math.abs(mockEditor.normCrop.bottom - 0.6) < 1e-9);
});

test('p2p-client.js gates reconnectTransport on closed sessions and isolates cancelled upload locks', async () => {
  const { P2PClient } = await import('../mobile-web/js/p2p-client.js');
  const client = new P2PClient({
    sessionId: 'sess-vaccine-1',
    encryptionKeyHex: 'a'.repeat(64),
    generation: 1,
  });

  client.isSessionIntentionallyClosed = true;
  assert.equal(client.reconnectTransport({ resetPatientRetry: true }), false);

  client.isSessionIntentionallyClosed = false;
  client.isCloudReady = true;
  client.cryptoKey = {};

  let releaseFirstReserve;
  let reserveCall = 0;
  let deliveryWaiterCalls = 0;
  client.createDeliveryWaiter = (...args) => {
    deliveryWaiterCalls++;
    return P2PClient.prototype.createDeliveryWaiter.apply(client, args);
  };
  client.relayAuth = {
    grant: 'grant-token',
    close: () => {},
    reserve: () => {
      reserveCall++;
      if (reserveCall === 1) {
        return new Promise((resolve) => { releaseFirstReserve = resolve; });
      }
      return new Promise(() => {});
    },
  };

  const firstSend = client.sendImage({ size: 128, type: 'image/jpeg' }, {});
  assert.equal(client.sendingImage, true);

  client.cancelPendingDelivery('Hủy để thử lại');
  assert.equal(client.sendingImage, false);

  // Immediately start a retry before the first cancelled reserve resolves
  const secondSend = client.sendImage({ size: 128, type: 'image/jpeg' }, {});
  assert.equal(client.sendingImage, true);

  releaseFirstReserve();
  const firstRes = await firstSend;
  assert.equal(firstRes.success, false);
  assert.equal(firstRes.status, 'HIS_UNKNOWN');
  assert.equal(deliveryWaiterCalls, 0, 'Cancelled first upload must not create a deliveryWaiter');
  assert.equal(client.sendingImage, true, 'Cancelled first upload finally must not unlock active second upload');
  void secondSend;
  client.destroy();
});

test('mobile-web/index.html wires fail-closed confirm modal, stall cancel guard, ECG grid gating, session cleanup, and mobile-safe thumbnails', () => {
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

  for (const requiredId of ['hisConfirmModal', 'btnCancelUploadWait', 'btnDocSizeWarn', 'btnDocMoveLeft', 'btnDocMoveRight']) {
    assert.match(html, new RegExp(`id="${requiredId}"`), `Expected #${requiredId} in index.html`);
  }
  assert.match(html, /id="btnToggleGrid"[^>]*class="[^"]*\bspecialty-tool-ecg\b/);

  const hashchangeMatch = script.match(/window\.addEventListener\('hashchange'[\s\S]*?\n    \}\);/);
  assert.ok(hashchangeMatch, 'Expected hashchange listener in inline module script');
  assert.match(hashchangeMatch[0], /docPages\s*=\s*\[\];/);
  assert.match(hashchangeMatch[0], /docSelectedIndex\s*=\s*-1;/);
  assert.match(hashchangeMatch[0], /hasActiveEditorImage\s*=\s*false;/);
  assert.match(hashchangeMatch[0], /URL\.revokeObjectURL\(p\.previewUrl\)/);

  const dragAttachMatch = script.match(/function attachThumbnailDragListeners\([\s\S]*?\n    \}/);
  assert.ok(dragAttachMatch, 'Expected attachThumbnailDragListeners function');
  assert.doesNotMatch(
    dragAttachMatch[0],
    /addEventListener\(['"]touch(start|move|end)['"]/,
    'Mobile thumbnails must not bind touchstart/touchmove/touchend drag handlers that hijack scrolling'
  );

  assert.match(script, /function invalidateActiveUploads\(/);
  const uploadIdGuards = script.match(/if\s*\(uploadId\s*!==\s*_activeUploadId\)\s*return;/g) || [];
  assert.ok(uploadIdGuards.length >= 6, 'Both image and PDF upload handlers must verify uploadId across async awaits and timers');
});

test('mobile-web/privacy.html preserves exact authorized access phrasing and Teal palette', () => {
  const privacyPath = path.join(rootDir, 'mobile-web/privacy.html');
  const privacyHtml = fs.readFileSync(privacyPath, 'utf8');
  assert.ok(
    privacyHtml.includes('được người dùng cho phép truy cập'),
    'privacy.html must preserve exact phrasing "được người dùng cho phép truy cập"'
  );
  assert.match(privacyHtml, /--accent:\s*#087f8c;/);
  assert.match(privacyHtml, /--accent-heading:\s*#0f766e;/);
});
