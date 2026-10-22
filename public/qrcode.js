/**
 * 极简 QR Code 编码器（byte 模式 / 纠错等级 M / 版本 1-10）。
 *
 * 为什么手写：项目是零依赖的，支付链接又是运行时才拿到的，
 * 不能打外部二维码接口（那等于把订单号发给第三方）。
 *
 * 用法：
 *   const qr = QRLite.encode('https://...');
 *   qr.size        // 每边模块数
 *   qr.modules[r][c] // true = 黑
 */
(function (global) {
  'use strict';

  // 纠错等级 M 的块结构：版本 → { ec: 每块纠错码字数, blocks: [[块数, 每块数据码字数], ...] }
  // 数据来自 ISO/IEC 18004 表 9；下面的 __selfCheck 会拿几何可用模块数反验这张表。
  var BLOCKS_M = {
    1: { ec: 10, blocks: [[1, 16]] },
    2: { ec: 16, blocks: [[1, 28]] },
    3: { ec: 26, blocks: [[1, 44]] },
    4: { ec: 18, blocks: [[2, 32]] },
    5: { ec: 24, blocks: [[2, 43]] },
    6: { ec: 16, blocks: [[4, 27]] },
    7: { ec: 18, blocks: [[4, 31]] },
    8: { ec: 22, blocks: [[2, 38], [2, 39]] },
    9: { ec: 22, blocks: [[3, 36], [2, 37]] },
    10: { ec: 26, blocks: [[4, 43], [1, 44]] }
  };

  // 对齐图形中心坐标（版本 1-10）
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (!a || !b) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsPoly(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsPoly(ecLen);
    var buf = new Uint8Array(data.length + ecLen);
    buf.set(data, 0);
    for (var i = 0; i < data.length; i++) {
      var coef = buf[i];
      if (!coef) continue;
      for (var j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
    }
    return buf.slice(data.length);
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function dataCodewords(version) {
    var b = BLOCKS_M[version];
    var sum = 0;
    for (var i = 0; i < b.blocks.length; i++) sum += b.blocks[i][0] * b.blocks[i][1];
    return sum;
  }

  function totalCodewords(version) {
    var b = BLOCKS_M[version];
    var n = 0;
    for (var i = 0; i < b.blocks.length; i++) n += b.blocks[i][0];
    return dataCodewords(version) + b.ec * n;
  }

  function ccBits(version) {
    return version < 10 ? 8 : 16;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      var need = 4 + ccBits(v) + byteLen * 8;
      if (need <= dataCodewords(v) * 8) return v;
    }
    return null;
  }

  function makeBitBuffer() {
    var bits = [];
    return {
      bits: bits,
      put: function (value, length) {
        for (var i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
      },
      length: function () { return bits.length; }
    };
  }

  function buildCodewords(version, bytes) {
    var total = dataCodewords(version);
    var bb = makeBitBuffer();
    bb.put(4, 4);                 // byte 模式
    bb.put(bytes.length, ccBits(version));
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);

    var cap = total * 8;
    var term = Math.min(4, cap - bb.length());
    if (term > 0) bb.put(0, term);
    while (bb.length() % 8 !== 0) bb.bits.push(0);

    var data = [];
    for (var k = 0; k < bb.bits.length; k += 8) {
      var byteVal = 0;
      for (var j = 0; j < 8; j++) byteVal = (byteVal << 1) | bb.bits[k + j];
      data.push(byteVal);
    }
    var pads = [0xec, 0x11];
    var p = 0;
    while (data.length < total) data.push(pads[p++ % 2]);
    return data;
  }

  function interleave(version, data) {
    var spec = BLOCKS_M[version];
    var ecLen = spec.ec;
    var blocks = [];
    var offset = 0;
    for (var i = 0; i < spec.blocks.length; i++) {
      var count = spec.blocks[i][0];
      var len = spec.blocks[i][1];
      for (var n = 0; n < count; n++) {
        var chunk = data.slice(offset, offset + len);
        offset += len;
        blocks.push({ data: chunk, ec: rsEncode(chunk, ecLen) });
      }
    }

    var out = [];
    var maxLen = 0;
    for (var b = 0; b < blocks.length; b++) maxLen = Math.max(maxLen, blocks[b].data.length);
    for (var d = 0; d < maxLen; d++) {
      for (var b2 = 0; b2 < blocks.length; b2++) {
        if (d < blocks[b2].data.length) out.push(blocks[b2].data[d]);
      }
    }
    for (var e = 0; e < ecLen; e++) {
      for (var b3 = 0; b3 < blocks.length; b3++) out.push(blocks[b3].ec[e]);
    }
    return out;
  }

  function buildMatrix(version, codewords, maskPattern) {
    var size = 17 + version * 4;
    var m = [];
    for (var r = 0; r < size; r++) m.push(new Array(size).fill(null));

    function set(r2, c2, dark) {
      if (r2 < 0 || r2 >= size || c2 < 0 || c2 >= size) return;
      m[r2][c2] = !!dark;
    }

    function placeFinder(row, col) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var r3 = row + dr, c3 = col + dc;
          if (r3 < 0 || r3 >= size || c3 < 0 || c3 >= size) continue;
          var ring = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                     (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
          var core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          set(r3, c3, ring || core);
        }
      }
    }
    placeFinder(0, 0);
    placeFinder(size - 7, 0);
    placeFinder(0, size - 7);

    for (var i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    var aligns = ALIGN[version] || [];
    // 跳过与三个定位图形重叠的对齐图形时，只能按「位置」判断：
    // 若用「中心点是否已被占位」，落在第 6 行/列（时序图形）上的对齐图形会被误判。
    function overlapsFinder(r4, c4) {
      return (r4 <= 7 && c4 <= 7) ||
             (r4 <= 7 && c4 >= size - 8) ||
             (r4 >= size - 8 && c4 <= 7);
    }
    for (var a = 0; a < aligns.length; a++) {
      for (var b = 0; b < aligns.length; b++) {
        var ar = aligns[a], ac = aligns[b];
        if (overlapsFinder(ar, ac)) continue;
        for (var dr2 = -2; dr2 <= 2; dr2++) {
          for (var dc2 = -2; dc2 <= 2; dc2++) {
            set(ar + dr2, ac + dc2, Math.max(Math.abs(dr2), Math.abs(dc2)) !== 1);
          }
        }
      }
    }

    set(size - 8, 8, true);   // 固定暗模块

    // 格式信息占位（先填 0，最后按真实值重填）
    for (var f = 0; f < 15; f++) {
      if (f < 6) set(f, 8, false);
      else if (f < 8) set(f + 1, 8, false);
      else set(size - 15 + f, 8, false);

      if (f < 8) set(8, size - 1 - f, false);
      else if (f === 8) set(8, 7, false);
      else set(8, 15 - f - 1, false);
    }

    if (version >= 7) {
      for (var v = 0; v < 18; v++) {
        set(Math.floor(v / 3), (v % 3) + size - 11, false);
        set((v % 3) + size - 11, Math.floor(v / 3), false);
      }
    }

    // 数据放置（codewords 传 null 时只搭功能图形，供自检统计空位）
    var bitIndex = 7;
    var byteIndex = 0;
    var inc = -1;
    var row = size - 1;
    for (var col = size - 1; codewords && col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (var c = 0; c < 2; c++) {
          var targetCol = col - c;
          if (m[row][targetCol] === null) {
            var dark = false;
            if (byteIndex < codewords.length) {
              dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
            }
            if (maskFn(maskPattern, row, targetCol)) dark = !dark;
            m[row][targetCol] = dark;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
      }
    }

    // 真实格式信息
    var eccBits = 0; // M
    var fmt = (eccBits << 3) | maskPattern;
    var fmtBits = (fmt << 10) | bchRemainder(fmt, 0x537, 10);
    fmtBits ^= 0x5412;
    for (var g = 0; g < 15; g++) {
      var bit = ((fmtBits >> g) & 1) === 1;
      if (g < 6) m[g][8] = bit;
      else if (g < 8) m[g + 1][8] = bit;
      else m[size - 15 + g][8] = bit;

      if (g < 8) m[8][size - 1 - g] = bit;
      else if (g === 8) m[8][7] = bit;
      else m[8][15 - g - 1] = bit;
    }
    m[size - 8][8] = true;

    if (version >= 7) {
      var verBits = (version << 12) | bchRemainder(version, 0x1f25, 12);
      for (var v2 = 0; v2 < 18; v2++) {
        var vbit = ((verBits >> v2) & 1) === 1;
        m[Math.floor(v2 / 3)][(v2 % 3) + size - 11] = vbit;
        m[(v2 % 3) + size - 11][Math.floor(v2 / 3)] = vbit;
      }
    }

    return m;
  }

  function bchRemainder(value, poly, degree) {
    // 用「位长对齐」迭代，别用固定位移——degree 以下会出现负位移，JavaScript 的
    // << 对负数按 &31 处理，会算出完全错误的格式/版本信息（表现为只有个别掩码能扫）。
    var v = value << degree;
    var polyBits = bitLength(poly);
    while (bitLength(v) >= polyBits) {
      v ^= poly << (bitLength(v) - polyBits);
    }
    return v;
  }

  function bitLength(n) {
    var len = 0;
    while (n) { len++; n >>>= 1; }
    return len;
  }

  function maskFn(pattern, i, j) {
    switch (pattern) {
      case 0: return (i + j) % 2 === 0;
      case 1: return i % 2 === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
      case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
      case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
      default: return false;
    }
  }

  function penalty(m) {
    var size = m.length;
    var score = 0;
    var r, c, run, dark;

    for (r = 0; r < size; r++) {
      run = 1; dark = m[r][0];
      for (c = 1; c < size; c++) {
        if (m[r][c] === dark) { run++; continue; }
        if (run >= 5) score += 3 + (run - 5);
        run = 1; dark = m[r][c];
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (c = 0; c < size; c++) {
      run = 1; dark = m[0][c];
      for (r = 1; r < size; r++) {
        if (m[r][c] === dark) { run++; continue; }
        if (run >= 5) score += 3 + (run - 5);
        run = 1; dark = m[r][c];
      }
      if (run >= 5) score += 3 + (run - 5);
    }

    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    var pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    var pat2 = pat1.slice().reverse();
    function matchAt(arr, start, pat) {
      for (var k = 0; k < pat.length; k++) if (arr[start + k] !== pat[k]) return false;
      return true;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c <= size - 11; c++) {
        var rowSeg = m[r].slice(c, c + 11);
        if (matchAt(rowSeg, 0, pat1) || matchAt(rowSeg, 0, pat2)) score += 40;
      }
    }
    for (c = 0; c < size; c++) {
      for (r = 0; r <= size - 11; r++) {
        var colSeg = [];
        for (var k = 0; k < 11; k++) colSeg.push(m[r + k][c]);
        if (matchAt(colSeg, 0, pat1) || matchAt(colSeg, 0, pat2)) score += 40;
      }
    }

    var darkCount = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c]) darkCount++;
    var percent = (darkCount * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  function selfCheck() {
    var problems = [];
    for (var v = 1; v <= 10; v++) {
      var size = 17 + v * 4;
      var m = buildMatrix(v, null, 0);
      var free = 0;
      for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) if (m[r][c] === null) free++;
      var expected = totalCodewords(v);
      var actual = Math.floor(free / 8);
      if (actual !== expected) problems.push({ version: v, expected: expected, actual: actual });
    }
    return problems;
  }

  function encode(text, opts) {
    opts = opts || {};
    var bytes = utf8Bytes(String(text));
    var version = opts.version || pickVersion(bytes.length);
    if (!version) throw new Error('内容过长，超出本编码器支持的版本 10 容量');

    var data = buildCodewords(version, bytes);
    var codewords = interleave(version, data);

    var best = null;
    var patterns = opts.mask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask];
    for (var i = 0; i < patterns.length; i++) {
      var matrix = buildMatrix(version, codewords, patterns[i]);
      var score = penalty(matrix);
      if (!best || score < best.score) best = { matrix: matrix, score: score, mask: patterns[i] };
    }

    return {
      version: version,
      size: best.matrix.length,
      mask: best.mask,
      modules: best.matrix
    };
  }

  function toCanvas(canvas, text, opts) {
    opts = opts || {};
    var qr = encode(text, opts);
    var quiet = opts.quiet == null ? 4 : opts.quiet;
    var scale = opts.scale || 6;
    var dim = (qr.size + quiet * 2) * scale;
    canvas.width = dim;
    canvas.height = dim;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.light || '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = opts.dark || '#000000';
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (!qr.modules[r][c]) continue;
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    return qr;
  }

  global.QRLite = { encode: encode, toCanvas: toCanvas, selfCheck: selfCheck };
})(typeof window !== 'undefined' ? window : globalThis);
