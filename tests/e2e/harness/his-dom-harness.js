/**
 * HIS CamSync - In-Memory HIS DOM & Cryptographic Harness
 * Simulates VNPT HIS browser environment, DataTransfer file injection,
 * and session cryptography.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export class MockDOMElement extends EventEmitter {
  constructor(tagName = 'div', id = '', className = '') {
    super();
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.className = className;
    this.innerText = '';
    this.innerHTML = '';
    this.value = '';
    this.files = [];
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.attributes = new Map();
    this.disabled = false;
  }

  setAttribute(name, val) {
    this.attributes.set(name, String(val));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
    return child;
  }

  querySelector(selector) {
    if (selector.startsWith('#')) {
      const targetId = selector.slice(1);
      if (this.id === targetId) return this;
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
    } else if (selector.startsWith('.')) {
      const targetClass = selector.slice(1);
      if (this.className.split(/\s+/).includes(targetClass)) return this;
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
    } else {
      if (this.tagName.toLowerCase() === selector.toLowerCase()) return this;
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    if (selector.startsWith('#')) {
      if (this.id === selector.slice(1)) results.push(this);
    } else if (selector.startsWith('.')) {
      if (this.className.split(/\s+/).includes(selector.slice(1))) results.push(this);
    } else {
      if (this.tagName.toLowerCase() === selector.toLowerCase()) results.push(this);
    }
    for (const child of this.children) {
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }

  click() {
    this.emit('click', { target: this, type: 'click' });
  }

  dispatchEvent(event) {
    this.emit(event.type, event);
    return true;
  }
}

export class MockDataTransfer {
  constructor() {
    this.items = [];
    this.files = [];
  }

  addFile(file) {
    this.files.push(file);
    this.items.push({ kind: 'file', getAsFile: () => file });
  }
}

export class HisDomHarness {
  constructor() {
    this.body = new MockDOMElement('body');
    this.document = {
      body: this.body,
      getElementById: (id) => this.body.querySelector(`#${id}`),
      querySelector: (sel) => this.body.querySelector(sel),
      querySelectorAll: (sel) => this.body.querySelectorAll(sel),
      createElement: (tag) => new MockDOMElement(tag)
    };

    this.setupHisPage();
  }

  setupHisPage(patient = { id: '24089123', name: 'NGUYEN VAN A', age: 45 }) {
    this.body.children = [];

    // Patient Banner
    const banner = new MockDOMElement('div', 'patientInfo', 'patient-banner');
    banner.innerText = `Mã bệnh nhân: ${patient.id} - Tên bệnh nhân: ${patient.name} - Tuổi: ${patient.age} Tuổi`;
    this.body.appendChild(banner);

    // Form container
    const uploadForm = new MockDOMElement('form', 'frmUpload');
    const fileInput = new MockDOMElement('input', 'fileUpload');
    fileInput.setAttribute('type', 'file');
    fileInput.setAttribute('accept', 'image/*');
    uploadForm.appendChild(fileInput);

    const uploadBtn = new MockDOMElement('button', 'btnUpload', 'btn btn-primary');
    uploadBtn.innerText = 'Lưu Ảnh';
    uploadForm.appendChild(uploadBtn);

    this.body.appendChild(uploadForm);
  }

  /**
   * Production patient info scraping regex as specified in camsync-content.js
   */
  scrapePatientInfo() {
    const banner = this.document.getElementById('patientInfo');
    if (!banner || !banner.innerText) return null;

    const text = banner.innerText;
    const match = text.match(/Mã bệnh nhân:\s*([0-9]+)\s*-\s*Tên bệnh nhân:\s*([^-\n]+)(?:\s*-\s*Tuổi:\s*([0-9]+))?/i);
    if (match) {
      return {
        id: match[1].trim(),
        name: match[2].trim(),
        age: match[3] ? parseInt(match[3].trim(), 10) : null
      };
    }
    return null;
  }

  /**
   * Simulates injectFilesAndUpload from camsync-content.js
   */
  injectFilesAndUpload(file) {
    const fileInput = this.document.getElementById('fileUpload');
    const uploadBtn = this.document.getElementById('btnUpload');

    if (!fileInput) throw new Error('#fileUpload input element not found in DOM');

    const dt = new MockDataTransfer();
    dt.addFile(file);
    fileInput.files = dt.files;

    let changeTriggered = false;
    let clickTriggered = false;

    fileInput.on('change', () => { changeTriggered = true; });
    uploadBtn.on('click', () => { clickTriggered = true; });

    fileInput.dispatchEvent({ type: 'change', target: fileInput });
    uploadBtn.click();

    return {
      success: true,
      injectedFile: fileInput.files[0],
      changeTriggered,
      clickTriggered
    };
  }

  /**
   * Generates a 128-bit cryptographic session ID
   * Must have length 32 hex characters with zero timestamps
   */
  static generateSecureSessionId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generates the zero-PHI QR URL using hash fragment #session=...
   */
  static generateQrUrl(sessionId, baseUrl = 'https://fantasy-1608.github.io/his-camsync/mobile-web/') {
    return `${baseUrl}#session=${sessionId}`;
  }

  /**
   * Audits URL to verify zero patient PHI leakage
   */
  static verifyZeroPhiInUrl(url, patient = {}) {
    const parsed = new URL(url);
    const searchParams = parsed.searchParams;

    // Check search query parameters
    const suspiciousParams = ['id', 'patientId', 'patient_id', 'name', 'patient_name', 'bn', 'ma_bn', 'tuoi', 'age'];
    for (const p of suspiciousParams) {
      if (searchParams.has(p)) return false;
    }

    // Check URL string does not contain patient ID or patient name
    if (patient.id && url.includes(patient.id)) return false;
    if (patient.name && url.includes(encodeURIComponent(patient.name))) return false;

    // Must have hash containing session
    if (!parsed.hash || !parsed.hash.startsWith('#session=')) return false;

    return true;
  }
}
