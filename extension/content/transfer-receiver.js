/**
 * CamSync Transfer Receiver — Bộ nhận dữ liệu phân mảnh chuẩn y tế
 * Hợp nhất protocol cho cả WebRTC DataChannel và Supabase Realtime Broadcast.
 * Đảm bảo: Fail-Closed Integrity, Idempotent Dedup, Out-of-Order Grace, Memory Hygiene.
 *
 * Giao tiếp với module chính qua callbacks (Dependency Injection):
 * - onAssembled(data)      : Gọi khi 100% gói tin đã nhận đủ và ráp xong
 * - onError(tid, tx, code) : Gọi khi phiên truyền bị lỗi/thiếu/quá hạn
 * - onProgress(pct, info)  : Gọi cập nhật tiến độ
 */
(function () {
  'use strict';

  // Hằng số an toàn phân mảnh & truyền tải (P0-3, P0-5 Hardening)
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024;   // 15MB giới hạn dung lượng ảnh lâm sàng
  const MAX_TOTAL_CHUNKS = 2000;               // Giới hạn tối đa số chunk phân mảnh
  const MAX_ACTIVE_TRANSFERS = 50;             // Tối đa 50 phiên truyền dở dang đồng thời
  const TRANSFER_TTL_MS = 60000;               // 60 giây TTL dọn dẹp bộ nhớ (Memory Hygiene)
  const COMPLETE_WAIT_MS = 10000;              // 10 giây chờ gói tin đến bù nếu complete đến sớm
  const MAX_CHUNK_BYTES = 100 * 1024;          // 100KB kích thước tối đa cho 1 gói tin chunk

  class UnifiedTransferReceiver {
    /**
     * @param {object}   transfers  - Object lưu trữ phiên truyền dở dang (shared với module chính)
     * @param {object}   [callbacks]
     * @param {Function} [callbacks.onAssembled]  - async (assembledData) => void
     * @param {Function} [callbacks.onError]      - (transferId, tx, errorCode) => void
     * @param {Function} [callbacks.onProgress]   - (pct, kbInfo, title) => void
     */
    constructor(transfers = {}, callbacks = {}) {
      this.transfers = transfers;
      this.processedTransferIds = new Set();
      this.onAssembled = callbacks.onAssembled || null;
      this.onError = callbacks.onError || null;
      this.onProgress = callbacks.onProgress || null;
    }

    /**
     * Bắt đầu phiên nhận ảnh phân mảnh (CHUNK_START hoặc chunk_start)
     */
    begin(options) {
      const {
        transferId,
        totalChunks,
        totalSize,
        totalBytes,
        mimeType,
        filename,
        meta,
        transport = 'realtime',
        sendAck = null
      } = options || {};

      if (!transferId || typeof transferId !== 'string' || transferId.trim().length === 0) {
        console.warn('[CamSync] Từ chối phiên truyền: transferId không hợp lệ');
        if (sendAck) sendAck(false, 'invalid_transfer_id');
        return false;
      }

      // 1. Kiểm tra totalChunks: phải là số nguyên dương và không vượt quá MAX_TOTAL_CHUNKS
      if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > MAX_TOTAL_CHUNKS) {
        console.warn(`[CamSync] Từ chối phiên truyền ${transferId}: totalChunks (${totalChunks}) ngoài giới hạn an toàn [1..${MAX_TOTAL_CHUNKS}]`);
        if (sendAck) sendAck(false, 'invalid_total_chunks');
        return false;
      }

      // 2. Kiểm tra tổng dung lượng khai báo: không vượt quá MAX_IMAGE_BYTES (15MB)
      const rawSize = (typeof totalSize === 'number' ? totalSize : (typeof totalBytes === 'number' ? totalBytes : 0));
      if (typeof rawSize === 'number' && rawSize > MAX_IMAGE_BYTES) {
        console.warn(`[CamSync] Từ chối phiên truyền ${transferId}: dung lượng ${rawSize}B vượt quá giới hạn 15MB`);
        if (sendAck) sendAck(false, 'file_too_large');
        return false;
      }

      // 3. Xóa phiên cũ nếu trùng transferId
      this.cleanup(transferId);

      // 4. Giới hạn số lượng phiên dở dang đồng thời (chống tràn RAM)
      const activeKeys = Object.keys(this.transfers);
      if (activeKeys.length >= MAX_ACTIVE_TRANSFERS) {
        let oldestId = null;
        let oldestTime = Infinity;
        for (const tid of activeKeys) {
          const item = this.transfers[tid];
          const time = item?.createdAt || 0;
          if (time < oldestTime) {
            oldestTime = time;
            oldestId = tid;
          }
        }
        if (oldestId) {
          console.warn(`[CamSync] Vượt quá giới hạn ${MAX_ACTIVE_TRANSFERS} phiên dở dang, giải phóng phiên cũ nhất: ${oldestId}`);
          this.cleanup(oldestId);
        }
      }

      // 5. TTL 60 giây dọn dẹp bộ nhớ nếu phiên truyền bị bỏ dở (Memory Hygiene)
      const ttlTimer = setTimeout(() => {
        if (this.transfers[transferId]) {
          console.warn(`[CamSync] Phiên truyền ${transferId} (${transport}) quá hạn TTL 60s, giải phóng bộ nhớ.`);
          const tx = this.transfers[transferId];
          if (tx && tx.sendAck) {
            try { tx.sendAck(false, 'transfer_timeout'); } catch (e) { /* ignored */ }
          }
          if (this.onError) this.onError(transferId, tx, 'transfer_timeout');
          this.cleanup(transferId);
        }
      }, TRANSFER_TTL_MS);

      const encrypted = options.encrypted === true || options.meta?.encrypted === true;
      const iv = options.iv || options.meta?.iv || null;

      this.transfers[transferId] = {
        transferId,
        transport,
        sendAck,
        chunks: new Array(totalChunks),
        totalChunks,
        totalSize: rawSize,
        totalBytes: rawSize,
        mimeType: mimeType || meta?.mimeType || 'image/jpeg',
        filename: filename || meta?.name || '',
        meta: meta || {},
        encrypted,
        iv,
        received: 0,
        completed: false,
        createdAt: Date.now(),
        ttlTimer,
        timeoutId: ttlTimer, // Giữ tương thích ngược với các test suite Tier 5
        completeWaitTimer: null
      };

      if (this.onProgress) this.onProgress(0, '0 KB', 'Đang nhận ảnh từ ĐT (0%)...');
      return true;
    }

    /**
     * Tiếp nhận từng gói tin phân mảnh (CHUNK_DATA hoặc chunk_data)
     */
    acceptChunk(transferId, chunkIndex, data, iv = null, encrypted = undefined) {
      const tx = this.transfers[transferId];
      if (!tx) {
        console.warn(`[CamSync] Bỏ qua gói tin: transferId ${transferId} không tồn tại hoặc đã bị hủy`);
        return false;
      }
      if (iv && !tx.iv) tx.iv = iv;
      if (typeof encrypted === 'boolean') tx.encrypted = encrypted;

      // Chuẩn hóa và kiểm tra bounds của chunkIndex
      const idx = (typeof chunkIndex === 'number' ? chunkIndex : null);
      if (!Number.isInteger(idx) || idx < 0 || idx >= tx.totalChunks) {
        console.warn(`[CamSync] Bỏ qua gói tin không hợp lệ: index ${chunkIndex} ngoài khoảng [0..${tx.totalChunks - 1}]`);
        return false;
      }

      // Kiểm tra dữ liệu chunk
      if (typeof data !== 'string' || data.length === 0 || data.length > MAX_CHUNK_BYTES) {
        console.warn('[CamSync] Bỏ qua gói tin không hợp lệ: dữ liệu chunk rỗng hoặc vượt quá 100KB');
        return false;
      }

      // Nhận gói tin lũy tích (idempotent: không đếm trùng lặp nếu gói tin gửi lại)
      if (typeof tx.chunks[idx] !== 'string') {
        tx.chunks[idx] = data;
        tx.received++;
      } else {
        tx.chunks[idx] = data;
      }

      const pct = Math.round((tx.received / tx.totalChunks) * 100);
      const chunkKBScaling = tx.transport === 'webrtc' ? 16 : 64;
      const kbReceived = Math.round(tx.received * chunkKBScaling);
      const kbTotal = Math.round(tx.totalSize / 1024) || Math.round(tx.totalChunks * chunkKBScaling);
      if (this.onProgress) this.onProgress(pct, `${kbReceived} KB / ${kbTotal} KB`, `Đang nhận ảnh (${pct}%)...`);

      // Trường hợp complete đã đến trước: kiểm tra nếu gói tin vừa đến đủ 100%
      if (tx.completed && tx.received === tx.totalChunks) {
        this._assemble(transferId);
      }
      return true;
    }

    /**
     * Nhận thông báo hoàn tất phiên gửi (CHUNK_COMPLETE hoặc chunk_complete)
     */
    complete(transferId) {
      const tx = this.transfers[transferId];
      if (!tx) return false;

      tx.completed = true;

      if (tx.received === tx.totalChunks) {
        this._assemble(transferId);
      } else {
        // Gói tin complete đến trước (Out-of-order) do mạng chập chờn
        console.warn(`[CamSync] complete đến sớm cho ${transferId} (${tx.received}/${tx.totalChunks} gói). Đang chờ gói tin đến bù...`);
        if (!tx.completeWaitTimer) {
          tx.completeWaitTimer = setTimeout(() => {
            const currentTx = this.transfers[transferId];
            if (currentTx && currentTx.received < currentTx.totalChunks) {
              console.warn(`[CamSync] Hết 10s chờ gói tin cho ${transferId}: chỉ nhận ${currentTx.received}/${currentTx.totalChunks}. Từ chối nạp ảnh!`);
              if (this.onError) this.onError(transferId, currentTx, 'missing_chunks');
              this.cleanup(transferId);
            }
          }, COMPLETE_WAIT_MS);
        }
      }
      return true;
    }

    /**
     * Ráp nối dữ liệu khi đã nhận đủ 100% gói tin (Fail-Closed Integrity Check)
     * @private
     */
    _assemble(transferId) {
      const tx = this.transfers[transferId];
      if (!tx) return;

      // Rào chắn bảo vệ lâm sàng tuyệt đối: kiểm tra đủ 100% gói tin và không có lỗ hổng rỗng
      const isComplete = tx.completed &&
                         tx.received === tx.totalChunks &&
                         !tx.chunks.some(c => typeof c !== 'string');

      if (!isComplete) {
        console.warn(`[CamSync] Từ chối nạp ảnh ${transferId}: dữ liệu bị khuyết (${tx.received}/${tx.totalChunks}).`);
        if (this.onError) this.onError(transferId, tx, 'missing_chunks');
        this.cleanup(transferId);
        return;
      }

      if (this.processedTransferIds.has(transferId)) {
        console.warn(`[CamSync] Bỏ qua transferId ${transferId}: đã được hoàn tất trước đó`);
        this.cleanup(transferId);
        return;
      }
      this.processedTransferIds.add(transferId);

      // Dữ liệu đã vẹn toàn 100%: sao chép thông tin và hủy timer
      const fullBase64 = tx.chunks.join('');
      const assembledData = {
        transferId,
        fullBase64,
        meta: { ...tx.meta, name: tx.filename || tx.meta?.name },
        mimeType: tx.mimeType || 'image/jpeg',
        sendAck: tx.sendAck,
        transport: tx.transport,
        encrypted: tx.encrypted,
        iv: tx.iv
      };

      this.cleanup(transferId);

      // Chuyển giao cho module chính xử lý (E2EE, Clinical Validation, Injection)
      if (this.onAssembled) {
        this.onAssembled(assembledData);
      }
    }

    /**
     * Giải phóng tài nguyên và hủy các bộ hẹn giờ của phiên truyền
     */
    cleanup(transferId) {
      const tx = this.transfers[transferId];
      if (tx) {
        if (tx.ttlTimer) clearTimeout(tx.ttlTimer);
        if (tx.timeoutId && tx.timeoutId !== tx.ttlTimer) clearTimeout(tx.timeoutId);
        if (tx.completeWaitTimer) clearTimeout(tx.completeWaitTimer);
        delete this.transfers[transferId];
      }
    }

    /**
     * Giải phóng toàn bộ các phiên truyền dở dang (khi đóng modal hoặc hủy session)
     */
    purgeAll() {
      for (const tid of Object.keys(this.transfers)) {
        this.cleanup(tid);
      }
    }

    /**
     * Giải phóng các phiên truyền thuộc transport chỉ định
     */
    purgeByTransport(transportName) {
      for (const tid of Object.keys(this.transfers)) {
        if (this.transfers[tid]?.transport === transportName) {
          this.cleanup(tid);
        }
      }
    }

    // === Legacy compatibility aliases (cho test suite Tier 5-8 tương thích ngược) ===
    finalize(transferId) {
      return this._assemble(transferId);
    }
  }

  // Expose module API
  window.__CamSyncTransfer = {
    MAX_IMAGE_BYTES,
    MAX_TOTAL_CHUNKS,
    MAX_ACTIVE_TRANSFERS,
    TRANSFER_TTL_MS,
    COMPLETE_WAIT_MS,
    MAX_CHUNK_BYTES,
    UnifiedTransferReceiver
  };
})();
