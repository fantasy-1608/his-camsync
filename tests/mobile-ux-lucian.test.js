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
  ];
  for (const pattern of bannedLeaks) {
    assert.doesNotMatch(htmlWithoutScriptsOrComments, pattern);
  }
});
