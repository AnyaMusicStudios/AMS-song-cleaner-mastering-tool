/* zip.js — minimal STORE-only ZIP writer (no dependencies) */
(function (g) {
  'use strict';
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    const u8 = new Uint8Array(buf);
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
  }

  /**
   * STORE-only zip builder. Keeps only file handles, then assembles everything
   * into a single Blob at build() time, so memory stays flat for large batches.
   */
  class Zip {
    constructor() { this.entries = []; this.names = new Set(); }
    add(name, blob) {
      let n = name, i = 1;
      while (this.names.has(n)) {
        const dot = name.lastIndexOf('.');
        n = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
        i++;
      }
      this.names.add(n);
      this.entries.push({ name: n, blob: blob instanceof Blob ? blob : new Blob([blob]) });
      return n;
    }
    get length() { return this.entries.length; }
    get size() { return this.entries.reduce((s, e) => s + e.blob.size, 0); }

    async build() {
      const enc = new TextEncoder();
      const { time, date } = dosTime(new Date());
      const parts = [];
      const central = [];
      let offset = 0;

      for (const entry of this.entries) {
        const data = new Uint8Array(await entry.blob.arrayBuffer());
        const nameBytes = enc.encode(entry.name);
        const crc = crc32(data);
        const len = data.length;

        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);       // UTF-8 file names
        lv.setUint16(8, 0, true);            // store
        lv.setUint16(10, time, true);
        lv.setUint16(12, date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, len, true);
        lv.setUint32(22, len, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        local.set(nameBytes, 30);

        parts.push(local, data);

        const cen = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(cen.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, len, true);
        cv.setUint32(24, len, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        cen.set(nameBytes, 46);
        central.push(cen);

        offset += local.length + len;
      }

      const centralSize = central.reduce((s, c) => s + c.length, 0);
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, this.entries.length, true);
      ev.setUint16(10, this.entries.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, offset, true);

      return new Blob([...parts, ...central, end], { type: 'application/zip' });
    }
  }

  g.Zip = Zip;
})(window);
