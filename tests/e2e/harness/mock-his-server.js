/**
 * HIS CamSync - Mock VNPT HIS Web Server
 * Serves simulated VNPT HIS DOM structure, iframe containers,
 * and handles mock file upload POST endpoints.
 */

import express from 'express';
import cors from 'cors';
import { verifyJpegHeader } from './canvas-pixel-harness.js';

export class MockHisServer {
  constructor(port = 3838) {
    this.port = port;
    this.app = express();
    this.server = null;
    this.uploadedFiles = [];
    this.currentPatient = {
      id: '24089123',
      name: 'NGUYEN VAN A',
      age: 45,
      encounterId: 'ENC-001'
    };

    this.setupRoutes();
  }

  setupRoutes() {
    this.app.use(cors());
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.raw({ type: 'image/*', limit: '50mb' }));

    // Mock VNPT HIS Main UI Page
    this.app.get('/', (req, res) => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>VNPT HIS - Bệnh Viện Mẫu</title>
          <style>
            body { font-family: sans-serif; margin: 20px; }
            .patient-banner { background: #e0f2fe; padding: 12px; border-left: 4px solid #0284c7; margin-bottom: 20px; }
            .upload-box { border: 2px dashed #94a3b8; padding: 20px; border-radius: 8px; }
          </style>
        </head>
        <body>
          <div class="patient-banner" id="patientInfo">
            Mã bệnh nhân: ${this.currentPatient.id} - Tên bệnh nhân: ${this.currentPatient.name}${this.currentPatient.encounterId ? ` - Mã lượt khám: ${this.currentPatient.encounterId}` : ''} - Tuổi: ${this.currentPatient.age} Tuổi
          </div>

          <div class="upload-box">
            <h3>Nạp kết quả Cận Lâm Sàng</h3>
            <form id="frmUpload" enctype="multipart/form-data">
              <input type="file" id="fileUpload" name="fileUpload" accept="image/*">
              <input type="hidden" id="maLuotKham" value="${this.currentPatient.encounterId || ''}">
              <button type="button" id="btnUpload" class="btn btn-primary">Lưu Ảnh</button>
            </form>
          </div>

          <div id="gridUploadResults" style="margin-top: 20px;">
            <h4>Danh sách ảnh đã lưu (${this.uploadedFiles.length})</h4>
            <ul id="fileList">
              ${this.uploadedFiles.map(f => `<li>${f.filename} (${f.size} bytes) - Watermark: ${f.hasWatermark}</li>`).join('')}
            </ul>
          </div>
        </body>
        </html>
      `;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    });

    // File Upload Endpoint
    this.app.post('/api/his/upload', (req, res) => {
      const filename = req.headers['x-filename'] || `HIS_IMG_${Date.now()}.jpg`;
      let buffer = null;

      if (Buffer.isBuffer(req.body)) {
        buffer = req.body;
      } else if (req.body && req.body.data) {
        // Base64 JSON
        buffer = Buffer.from(req.body.data, 'base64');
      }

      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: 'No file data received' });
      }

      // Check standard JPEG JFIF header
      const headerCheck = verifyJpegHeader(buffer);
      if (!headerCheck.valid) {
        return res.status(415).json({
          error: 'VNPT HIS Error: Only valid JPEG images with JFIF header are accepted',
          details: headerCheck
        });
      }

      const fileRecord = {
        filename,
        size: buffer.length,
        receivedAt: new Date().toISOString(),
        patientId: this.currentPatient.id,
        hasWatermark: true
      };

      this.uploadedFiles.push(fileRecord);
      res.status(200).json({
        status: 'success',
        message: 'Tải tệp lên hệ thống VNPT HIS thành công',
        file: fileRecord
      });
    });

    // Query uploaded files
    this.app.get('/api/his/uploaded-files', (req, res) => {
      res.json({ count: this.uploadedFiles.length, files: this.uploadedFiles });
    });

    // Clear uploads
    this.app.post('/api/his/clear', (req, res) => {
      this.uploadedFiles = [];
      res.json({ status: 'cleared' });
    });
  }

  setPatient(patient) {
    this.currentPatient = { ...patient };
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        resolve(`http://localhost:${this.port}`);
      }).on('error', reject);
    });
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }
}
