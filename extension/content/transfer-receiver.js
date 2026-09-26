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

  // Hằng số an toàn phân mảnh & truyền tải (P0-3, P0-5 Hardening, Milestone 3)
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024;        // 15MB giới hạn dung lượng ảnh lâm sàng
  const MAX_CIPHERTEXT_BYTES = 20 * 1024 * 1024;   // 20MB giới hạn lũy tích payload mã hóa (V2)
  const MAX_TOTAL_CHUNKS = 2000;                    // Giới hạn tối đa số chunk phân mảnh
  const MAX_ACTIVE_TRANSFERS = 50;                  // Tối đa 50 phiên truyền dở dang đồng thời
  const TRANSFER_TTL_MS = 60000;                    // 60 giây TTL dọn dẹp bộ nhớ (Memory Hygiene)
  const COMPLETE_WAIT_MS = 10000;                   // 10 giây chờ gói tin đến bù nếu complete đến sớm
  const MAX_CHUNK_BYTES = 100 * 1024;               // 100KB kích thước tối đa cho 1 gói tin chunk

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
      this.transferStates = new Map();
      this.onAssembled = callbacks.onAssembled || null;
      this.onError = callbacks.onError || null;
      this.onProgress = callbacks.onProgress || null;
    }

    /**
     * Cập nhật trạng thái phiên truyền (P1-04 Transfer State Machine & Idempotency)
     * Trạng thái: RECEIVING -> VERIFIED -> HIS_PENDING -> COMMITTED | REJECTED | UNKNOWN
     */
    setTransferState(transferId, state, ackPayload = null) {
      if (!transferId) return;
      const existing = this.transferStates.get(transferId) || { transferId, createdAt: Date.now() };
      existing.state = state;
      if (ackPayload) existing.ackPayload = ackPayload;
      existing.updatedAt = Date.now();

      // Giới hạn an toàn FIFO / LRU tối đa 100 entries (24/7 Tab Hygiene)
      if (!this.transferStates.has(transferId) && this.transferStates.size >= 100) {
        const oldestKey = this.transferStates.keys().next().value;
        if (oldestKey) this.transferStates.delete(oldestKey);
      }
      this.transferStates.set(transferId, existing);

      // CHỈ đánh dấu vào processedTransferIds khi phiên đã ráp hoặc kết thúc (VERIFIED, COMMITTED, REJECTED, UNKNOWN)
      if (state === 'VERIFIED' || state === 'COMMITTED' || state === 'REJECTED' || state === 'UNKNOWN') {
        if (!this.processedTransferIds.has(transferId) && this.processedTransferIds.size >= 100) {
          const oldestId = this.processedTransferIds.values().next().value;
          if (oldestId) this.processedTransferIds.delete(oldestId);
        }
        this.processedTransferIds.add(transferId);
      }
    }

    /**
     * Lấy bản ghi trạng thái của transferId
     */
    getTransferState(transferId) {
      return this.transferStates.get(transferId) || null;
    }

    /**
     * Bắt đầu phiên nhận ảnh phân mảnh (V2 TransferStart hoặc legacy CHUNK_START / chunk_start)
     */
    begin(options) {
      const {
        transferId,
        totalChunks,
        totalSize,
        totalBytes,
        encryptedBytes,
        contentType,
        mimeType,
        filename,
        meta,
        v,
        transport = 'realtime',
        sendAck = null
      } = options || {};

      if (!transferId || typeof transferId !== 'string' || transferId.trim().length === 0) {
        console.warn('[CamSync] Từ chối phiên truyền: transferId không hợp lệ');
        if (sendAck) sendAck(false, 'invalid_transfer_id', { status: 'HIS_REJECTED', reason: 'transferId không hợp lệ' });
        return false;
      }

      // 1. Kiểm tra protocol version (V2 Enforcement)
      if (v !== undefined && v !== 2) {
        console.warn(`[CamSync] Từ chối phiên truyền ${transferId}: phiên bản giao thức không được hỗ trợ (v=${v})`);
        if (sendAck) sendAck(false, 'INVALID_PROTOCOL_VERSION', { status: 'HIS_REJECTED', reason: 'Chỉ hỗ trợ giao thức V2' });
        return false;
      }

      // 2. Kiểm tra contentType / mimeType nếu khai báo
      const declaredContentType = contentType || mimeType || meta?.contentType || meta?.mimeType;
      if (declaredContentType && declaredContentType !== 'image/jpeg' && declaredContentType !== 'image/png' && declaredContentType !== 'application/pdf') {
        console.warn(`[CamSync] Từ chối phiên truyền ${transferId}: contentType (${declaredContentType}) không được hỗ trợ`);
        if (sendAck) sendAck(false, 'UNSUPPORTED_CONTENT_TYPE', { status: 'HIS_REJECTED', reason: 'Chỉ hỗ trợ image/jpeg, image/png hoặc application/pdf' });
        return false;
      }

      // 3. Kiểm tra totalChunks: phải là số nguyên dương và không vượt quá MAX_TOTAL_CHUNKS
      if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > MAX_TOTAL_CHUNKS) {
        console.warn(`[CamSync] Từ chối phiên truyền ${transferId}: totalChunks (${totalChunks}) ngoài giới hạn an toàn [1..${MAX_TOTAL_CHUNKS}]`);
        if (sendAck) sendAck(false, 'invalid_total_chunks', { status: 'error', reason: 'Số lượng chunk ngoài giới hạn an toàn' });
        return false;
      }

      // 4. Kiểm tra tổng dung lượng khai báo: 15MB ảnh thường hoặc 20MB ciphertext
      const isEncryptedDeclared = options.encrypted === true || options.meta?.encrypted === true || encryptedBytes !== undefined;
      const rawSize = (typeof encryptedBytes === 'number' ? encryptedBytes : (typeof totalSize === 'number' ? totalSize : (typeof totalBytes === 'number' ? totalBytes : 0)));
      const sizeCeiling = isEncryptedDeclared ? MAX_CIPHERTEXT_BYTES : MAX_IMAGE_BYTES;

      if (typeof rawSize === 'number' && rawSize > sizeCeiling) {
        console.warn(`[CamSync] Từ chối phiên truyền ${transferId}: dung lượng ${rawSize}B vượt quá giới hạn ${sizeCeiling}B`);
        const errCode = rawSize > MAX_CIPHERTEXT_BYTES ? 'MAX_PAYLOAD_EXCEEDED' : 'file_too_large';
        if (sendAck) sendAck(false, errCode, { status: 'HIS_REJECTED', reason: 'Dung lượng payload vượt quá giới hạn an toàn' });
        return false;
      }

      // 5. Kiểm tra tính bất biến và chống trùng transferId (Idempotency - P1-04)
      const existingRecord = this.transferStates.get(transferId);
      if (existingRecord) {
        if (existingRecord.state === 'COMMITTED' || existingRecord.state === 'REJECTED' || existingRecord.state === 'UNKNOWN') {
          console.warn(`[CamSync Idempotency] Gói tin TransferStart lặp lại cho ${transferId} (trạng thái: ${existingRecord.state}). Trả về kết quả trước đó, không nạp lần hai.`);
          if (sendAck && existingRecord.ackPayload) {
            try {
              sendAck(existingRecord.state === 'COMMITTED', existingRecord.ackPayload.error || null, existingRecord.ackPayload);
            } catch (e) {}
          }
          return false;
        }
        if (existingRecord.state === 'HIS_PENDING' || existingRecord.state === 'VERIFIED') {
          console.warn(`[CamSync Idempotency] Gói tin TransferStart lặp lại cho ${transferId} trong khi đang xử lý (${existingRecord.state}). Bỏ qua yêu cầu lặp.`);
          return false;
        }
      }

      this.setTransferState(transferId, 'RECEIVING');
      this.cleanup(transferId);

      // 6. Giới hạn số lượng phiên dở dang đồng thời (chống tràn RAM)
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

      // 7. TTL 60 giây dọn dẹp bộ nhớ nếu phiên truyền bị bỏ dở (Memory Hygiene)
      const ttlTimer = setTimeout(() => {
        if (this.transfers[transferId]) {
          console.warn(`[CamSync] Phiên truyền ${transferId} (${transport}) quá hạn TTL 60s, giải phóng bộ nhớ.`);
          const tx = this.transfers[transferId];
          if (tx && tx.sendAck) {
            try { tx.sendAck(false, 'transfer_timeout', { status: 'HIS_REJECTED', reason: 'Hết thời gian chờ nhận phân mảnh (60s TTL)' }); } catch (e) { /* ignored */ }
          }
          if (this.onError) this.onError(transferId, tx, 'transfer_timeout');
          this.cleanup(transferId);
        }
      }, TRANSFER_TTL_MS);

      const encrypted = options.encrypted !== undefined ? options.encrypted : (options.meta?.encrypted !== undefined ? options.meta.encrypted : undefined);
      const iv = options.iv || options.meta?.iv || null;
      const generation = options.generation !== undefined ? options.generation : (options.meta?.generation !== undefined ? options.meta.generation : undefined);
      const sid = options.sid || options.sessionId || options.meta?.sid || options.meta?.sessionId || undefined;

      this.transfers[transferId] = {
        transferId,
        v: v !== undefined ? v : options.v,
        transport,
        sendAck,
        chunks: new Array(totalChunks),
        totalChunks,
        totalSize: rawSize,
        totalBytes: rawSize,
        encryptedBytes: rawSize,
        totalCiphertextBytes: 0,
        contentType: declaredContentType || 'image/jpeg',
        mimeType: declaredContentType || 'image/jpeg',
        filename: filename || meta?.name || '',
        meta: meta || {},
        generation,
        sid,
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
     * Tiếp nhận từng gói tin phân mảnh (V2 TransferChunk hoặc legacy CHUNK_DATA / chunk_data)
     */
    acceptChunk(transferId, chunkIndex, data, iv = null, encrypted = undefined) {
      const existingRecord = this.transferStates.get(transferId);
      if (existingRecord && (existingRecord.state === 'COMMITTED' || existingRecord.state === 'REJECTED' || existingRecord.state === 'UNKNOWN')) {
        console.warn(`[CamSync Idempotency] Bỏ qua chunk lặp cho ${transferId} vì phiên đã ở trạng thái ${existingRecord.state}`);
        return true;
      }
      if (existingRecord && existingRecord.state === 'HIS_PENDING') {
        console.warn(`[CamSync Idempotency] Bỏ qua chunk lặp cho ${transferId}: đang chờ lưu trên HIS`);
        return true;
      }

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

      // RÀO CHẮN DUPLICATE CHUNK & PHÁT HIỆN CONFLICT (Milestone 3, F14, F16)
      if (typeof tx.chunks[idx] === 'string') {
        if (tx.chunks[idx] === data) {
          // Gói tin trùng lặp với dữ liệu GIỐNG NHAU: xử lý idempotent, bỏ qua an toàn
          return true;
        } else {
          // Gói tin trùng index nhưng dữ liệu KHÁC NHAU: FAIL-CLOSED NGAY LẬP TỨC
          console.warn(`[CamSync] Xung đột dữ liệu chunk tại index ${idx} cho ${transferId}. Hủy phiên truyền fail-closed.`);
          if (tx.sendAck) {
            try {
              tx.sendAck(false, 'CONFLICTING_CHUNK_DATA', {
                status: 'HIS_REJECTED',
                reason: 'Phát hiện dữ liệu phân mảnh xung đột (conflicting chunk data)'
              });
            } catch (e) {}
          }
          if (this.onError) this.onError(transferId, tx, 'CONFLICTING_CHUNK_DATA');
          this.cleanup(transferId);
          return false;
        }
      }

      // Giới hạn lũy tích dung lượng ciphertext tối đa 20MB (Anti-DoS)
      tx.totalCiphertextBytes = (tx.totalCiphertextBytes || 0) + data.length;
      if (tx.totalCiphertextBytes > MAX_CIPHERTEXT_BYTES) {
        console.warn(`[CamSync] Dung lượng payload lũy tích ${transferId} (${tx.totalCiphertextBytes}B) vượt quá trần 20MB. Hủy phiên.`);
        if (tx.sendAck) {
          try {
            tx.sendAck(false, 'MAX_PAYLOAD_EXCEEDED', {
              status: 'HIS_REJECTED',
              reason: 'Dung lượng payload mã hóa vượt quá trần 20MB'
            });
          } catch (e) {}
        }
        if (this.onError) this.onError(transferId, tx, 'MAX_PAYLOAD_EXCEEDED');
        this.cleanup(transferId);
        return false;
      }

      // Nhận gói tin mới vào mảng
      tx.chunks[idx] = data;
      tx.received++;

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
     * Nhận thông báo hoàn tất phiên gửi (V2 TransferEnd hoặc legacy CHUNK_COMPLETE / chunk_complete)
     */
    complete(transferId) {
      const existingRecord = this.transferStates.get(transferId);
      if (existingRecord && (existingRecord.state === 'COMMITTED' || existingRecord.state === 'REJECTED' || existingRecord.state === 'UNKNOWN')) {
        console.warn(`[CamSync Idempotency] Bỏ qua complete lặp cho ${transferId} (trạng thái: ${existingRecord.state})`);
        const tx = this.transfers[transferId];
        const ackFn = tx?.sendAck;
        if (ackFn && existingRecord.ackPayload) {
          try {
            ackFn(existingRecord.state === 'COMMITTED', existingRecord.ackPayload.error || null, existingRecord.ackPayload);
          } catch (e) {}
        }
        return true;
      }

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
     * Phương thức thống nhất nạp gói tin từ mọi nguồn truyền dẫn (WebRTC DataChannel / Supabase Realtime)
     * Tự động nhận diện và điều hướng gói tin V2 (TransferStart, TransferChunk, TransferEnd)
     * @param {object} packet
     * @param {object} [options]
     * @returns {boolean}
     */
    ingest(packet, { transport = 'realtime', sendAck = null, activeSessionId = null } = {}) {
      if (!packet || typeof packet !== 'object') return false;

      // 1. Kiểm tra protocol version nếu có khai báo
      if (packet.v !== undefined && packet.v !== 2) {
        console.warn(`[CamSync] Rejecting packet: unsupported protocol version ${packet.v}`);
        if (sendAck) sendAck(false, 'INVALID_PROTOCOL_VERSION', { status: 'HIS_REJECTED', reason: 'Phiên bản giao thức không hợp lệ' });
        return false;
      }

      // 2. Ingress Session Binding
      const incomingSid = packet.sid || packet.sessionId;
      if (activeSessionId && incomingSid && incomingSid !== activeSessionId) {
        console.warn(`[CamSync] Rejecting packet: sid mismatch (${incomingSid} != ${activeSessionId})`);
        if (sendAck) sendAck(false, 'SESSION_MISMATCH', { status: 'HIS_REJECTED', reason: 'Gói tin không khớp phiên làm việc' });
        return false;
      }

      // 3. Phân biệt loại gói tin: Start
      if (packet.totalChunks !== undefined || packet.type === 'TransferStart' || packet.type === 'CHUNK_START') {
        return this.begin({
          ...packet,
          totalSize: packet.encryptedBytes ?? packet.totalBytes ?? packet.totalSize,
          mimeType: packet.contentType ?? packet.mimeType,
          transport,
          sendAck
        });
      }

      // 4. Phân biệt loại gói tin: Chunk
      if (packet.index !== undefined || packet.chunkIndex !== undefined || packet.type === 'TransferChunk' || packet.type === 'CHUNK_DATA') {
        const idx = packet.index !== undefined ? packet.index : packet.chunkIndex;
        const data = packet.data !== undefined ? packet.data : packet.chunk;
        return this.acceptChunk(packet.transferId, idx, data, packet.iv, packet.encrypted);
      }

      // 5. Phân biệt loại gói tin: End
      if (packet.type === 'TransferEnd' || packet.type === 'CHUNK_COMPLETE' || (packet.transferId && !packet.data && !packet.totalChunks)) {
        return this.complete(packet.transferId);
      }

      return false;
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
      // Giới hạn an toàn FIFO / LRU tối đa 100 entries để tránh rò rỉ bộ nhớ khi tab chạy 24/7 (Zero-Garbage Hygiene)
      if (this.processedTransferIds.size >= 100) {
        const oldestId = this.processedTransferIds.values().next().value;
        if (oldestId !== undefined) {
          this.processedTransferIds.delete(oldestId);
        }
      }
      this.processedTransferIds.add(transferId);

      // Dữ liệu đã vẹn toàn 100%: sao chép thông tin và hủy timer
      const fullBase64 = tx.chunks.join('');
      const assembledData = {
        transferId,
        v: tx.v,
        fullBase64,
        meta: { ...tx.meta, name: tx.filename || tx.meta?.name },
        mimeType: tx.contentType || tx.mimeType || 'image/jpeg',
        contentType: tx.contentType || tx.mimeType || 'image/jpeg',
        generation: tx.generation,
        sid: tx.sid,
        sendAck: tx.sendAck,
        transport: tx.transport,
        encrypted: tx.encrypted,
        iv: tx.iv
      };

      this.setTransferState(transferId, 'VERIFIED');
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
      if (this.processedTransferIds) {
        this.processedTransferIds.clear();
      }
      if (this.transferStates) {
        this.transferStates.clear();
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
    MAX_CIPHERTEXT_BYTES,
    MAX_TOTAL_CHUNKS,
    MAX_ACTIVE_TRANSFERS,
    TRANSFER_TTL_MS,
    COMPLETE_WAIT_MS,
    MAX_CHUNK_BYTES,
    UnifiedTransferReceiver
  };
})();
