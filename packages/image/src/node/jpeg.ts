import {
  assertDimensions,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_PIXELS,
  ImageLimitError,
  type RowSink,
} from './raster';

/**
 * Pure TypeScript JPEG decoder for placeholder generation: baseline, extended-sequential and progressive
 * Huffman JPEGs with 8-bit samples, any chroma subsampling, restart intervals, grayscale, YCbCr, RGB, CMYK
 * and YCCK. Arithmetic coding, lossless and 12-bit JPEGs are rejected with a clear error.
 *
 * When the target is at most 1/8 of the picture it decodes only the DC coefficients: a block's DC value is
 * the exact mean of its 8×8 pixels, so that is an 8× box downscale for free, and progressive files can skip
 * every AC scan. That is what libjpeg's reduced-size decoding (and therefore sharp's shrink-on-load) does too;
 * near sharp colour edges of chroma-subsampled pictures it is an approximation, so `exact` forces the full
 * decode.
 */

export interface JpegInfo {
  width: number;
  height: number;
  /** Number of colour components (1 gray, 3 colour, 4 CMYK). */
  components: number;
  progressive: boolean;
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7,
  14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]);

interface HuffmanTable {
  /** `(length << 8) | symbol` for every 8-bit prefix of a code of at most 8 bits; 0 otherwise. */
  lookup: Uint16Array;
  mincode: Int32Array;
  maxcode: Int32Array;
  valptr: Int32Array;
  symbols: Uint8Array;
}

function buildHuffman(counts: Uint8Array, symbols: Uint8Array): HuffmanTable {
  const lookup = new Uint16Array(256);
  const mincode = new Int32Array(17);
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1]!;
    valptr[l] = k;
    mincode[l] = code;
    if (n > 0) {
      if (l <= 8) {
        for (let i = 0; i < n; i++) {
          const shift = 8 - l;
          const base = (code + i) << shift;
          for (let j = 0; j < 1 << shift; j++) lookup[base | j] = (l << 8) | symbols[k + i]!;
        }
      }
      maxcode[l] = code + n - 1;
    }
    code = (code + n) << 1;
    k += n;
  }
  return { lookup, mincode, maxcode, valptr, symbols };
}

/** Zero bytes the reader may pad in after the data ran out before a scan gives up (a few MCUs of slack). */
const STARVED_AFTER = 16;

/** More scans than any real progressive file has (libjpeg-turbo's own script has ten). */
const MAX_SCANS = 256;

class BitReader {
  pos: number;
  private buffer = 0;
  private count = 0;
  private padded = 0;

  constructor(
    private readonly data: Uint8Array,
    start: number,
  ) {
    this.pos = start;
  }

  /** The entropy-coded data is used up: what is read now is padding. A scan stops there. */
  get starved(): boolean {
    return this.padded > STARVED_AFTER;
  }

  /** Makes at least 25 bits available (zero padded when the segment ended at a marker). */
  private fill(): void {
    while (this.count <= 24) {
      let byte = 0;
      if (this.pos < this.data.length) {
        byte = this.data[this.pos]!;
        if (byte === 0xff) {
          const next = this.data[this.pos + 1];
          if (next === 0x00) {
            this.pos += 2;
          } else {
            byte = 0; // marker or fill: do not consume, pad with zeros
            this.padded++;
          }
        } else {
          this.pos++;
        }
      } else {
        this.padded++;
      }
      this.buffer = (this.buffer << 8) | byte;
      this.count += 8;
    }
  }

  bits(n: number): number {
    if (n === 0) return 0;
    if (this.count < n) this.fill();
    this.count -= n;
    return (this.buffer >>> this.count) & ((1 << n) - 1);
  }

  bit(): number {
    if (this.count < 1) this.fill();
    this.count--;
    return (this.buffer >>> this.count) & 1;
  }

  /** Reads `n` bits and sign-extends them the JPEG way (`EXTEND`). */
  receive(n: number): number {
    if (n === 0) return 0;
    const v = this.bits(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }

  decode(table: HuffmanTable): number {
    if (this.count < 16) this.fill();
    const peek = (this.buffer >>> (this.count - 8)) & 0xff;
    const hit = table.lookup[peek]!;
    if (hit !== 0) {
      this.count -= hit >> 8;
      return hit & 0xff;
    }
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | this.bit();
      if (code <= table.maxcode[l]!) return table.symbols[table.valptr[l]! + code - table.mincode[l]!]!;
    }
    throw new Error('corrupt JPEG: invalid Huffman code');
  }

  /** Drops buffered bits and moves to the next `RSTn` marker (restart interval boundary). */
  restart(): void {
    this.count = 0;
    this.buffer = 0;
    while (this.pos + 1 < this.data.length) {
      if (this.data[this.pos] === 0xff) {
        const marker = this.data[this.pos + 1]!;
        if (marker >= 0xd0 && marker <= 0xd7) {
          this.pos += 2;
          this.padded = 0;
          return;
        }
        if (marker !== 0x00 && marker !== 0xff) return; // some other marker: stop in front of it
      }
      this.pos++;
    }
  }

  /** Position of the next marker segment after the entropy-coded data. */
  nextMarker(): number {
    let at = this.pos;
    while (at + 1 < this.data.length) {
      if (this.data[at] === 0xff) {
        const marker = this.data[at + 1]!;
        if (marker !== 0x00 && marker !== 0xff && !(marker >= 0xd0 && marker <= 0xd7)) return at;
      }
      at++;
    }
    return this.data.length;
  }
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  blocksPerLineForMcu: number;
  blocksPerColumnForMcu: number;
  coefficients: Int16Array | null;
  quant: Int32Array | null;
  dc: HuffmanTable | null;
  ac: HuffmanTable | null;
  pred: number;
}

interface Frame {
  progressive: boolean;
  width: number;
  height: number;
  components: Component[];
  hMax: number;
  vMax: number;
  mcusPerLine: number;
  mcusPerColumn: number;
}

interface Header {
  frame: Frame;
  adobeTransform: number | null;
  jfif: boolean;
}

function u16(data: Uint8Array, at: number): number {
  return (data[at]! << 8) | data[at + 1]!;
}

function parseFrame(data: Uint8Array, at: number, progressive: boolean): Frame {
  const precision = data[at]!;
  if (precision !== 8) throw new Error(`unsupported JPEG sample precision ${precision} bits`);
  const height = u16(data, at + 1);
  const width = u16(data, at + 3);
  const count = data[at + 5]!;
  if (height === 0) throw new Error('unsupported JPEG: height defined by a DNL marker');
  if (count !== 1 && count !== 3 && count !== 4) throw new Error(`unsupported JPEG component count ${count}`);
  const components: Component[] = [];
  let hMax = 1;
  let vMax = 1;
  for (let i = 0; i < count; i++) {
    const o = at + 6 + i * 3;
    const sampling = data[o + 1]!;
    const h = sampling >> 4;
    const v = sampling & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4) throw new Error('corrupt JPEG: invalid sampling factors');
    hMax = Math.max(hMax, h);
    vMax = Math.max(vMax, v);
    components.push({
      id: data[o]!,
      h,
      v,
      tq: data[o + 2]!,
      blocksPerLine: 0,
      blocksPerColumn: 0,
      blocksPerLineForMcu: 0,
      blocksPerColumnForMcu: 0,
      coefficients: null,
      quant: null,
      dc: null,
      ac: null,
      pred: 0,
    });
  }
  const mcusPerLine = Math.ceil(width / (8 * hMax));
  const mcusPerColumn = Math.ceil(height / (8 * vMax));
  for (const c of components) {
    c.blocksPerLine = Math.ceil(Math.ceil((width * c.h) / hMax) / 8);
    c.blocksPerColumn = Math.ceil(Math.ceil((height * c.v) / vMax) / 8);
    c.blocksPerLineForMcu = mcusPerLine * c.h;
    c.blocksPerColumnForMcu = mcusPerColumn * c.v;
  }
  return { progressive, width, height, components, hMax, vMax, mcusPerLine, mcusPerColumn };
}

const SOF_UNSUPPORTED = new Map<number, string>([
  [0xc3, 'lossless'],
  [0xc5, 'differential'],
  [0xc6, 'differential'],
  [0xc7, 'differential'],
  [0xc9, 'arithmetic-coded'],
  [0xca, 'arithmetic-coded'],
  [0xcb, 'arithmetic-coded'],
  [0xcd, 'arithmetic-coded'],
  [0xce, 'arithmetic-coded'],
  [0xcf, 'arithmetic-coded'],
]);

/** Reads the frame header only. */
export function probeJpeg(data: Uint8Array): JpegInfo {
  const header = scan(data, null);
  const { frame } = header;
  return {
    width: frame.width,
    height: frame.height,
    components: frame.components.length,
    progressive: frame.progressive,
  };
}

interface DecodeContext {
  dcOnly: boolean;
  quantTables: Array<Int32Array | null>;
  dcTables: Array<HuffmanTable | null>;
  acTables: Array<HuffmanTable | null>;
  restartInterval: number;
  onScan: ((frame: Frame, at: number) => number) | null;
}

/** Walks the marker segments; with a context it also decodes the scans. Returns the header it found. */
function scan(data: Uint8Array, context: DecodeContext | null): Header {
  if (!isJpeg(data)) throw new Error('not a JPEG file');
  let frame: Frame | null = null;
  let adobeTransform: number | null = null;
  let jfif = false;
  let scans = 0;
  let at = 2;

  while (at < data.length) {
    if (data[at] !== 0xff) {
      at++;
      continue;
    }
    while (data[at] === 0xff) at++;
    const marker = data[at++]!;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9) break;
    if (at + 2 > data.length) break;
    const length = u16(data, at);
    const body = at + 2;
    const end = at + length;

    if (SOF_UNSUPPORTED.has(marker)) {
      throw new Error(`unsupported JPEG: ${SOF_UNSUPPORTED.get(marker)} coding`);
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (frame) throw new Error('corrupt JPEG: more than one frame header');
      frame = parseFrame(data, body, marker === 0xc2);
      if (!context) return { frame, adobeTransform, jfif };
    } else if (marker === 0xe0) {
      if (
        data[body] === 0x4a &&
        data[body + 1] === 0x46 &&
        data[body + 2] === 0x49 &&
        data[body + 3] === 0x46
      ) {
        jfif = true;
      }
    } else if (marker === 0xee) {
      if (
        length >= 14 &&
        data[body] === 0x41 &&
        data[body + 1] === 0x64 &&
        data[body + 2] === 0x6f &&
        data[body + 3] === 0x62 &&
        data[body + 4] === 0x65
      ) {
        adobeTransform = data[body + 11]!;
      }
    } else if (context && marker === 0xdb) {
      let o = body;
      while (o < end) {
        const info = data[o++]!;
        const precision = info >> 4;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          if (precision === 0) table[ZIGZAG[i]!] = data[o++]!;
          else {
            table[ZIGZAG[i]!] = u16(data, o);
            o += 2;
          }
        }
        context.quantTables[info & 15] = table;
      }
    } else if (context && marker === 0xc4) {
      let o = body;
      while (o + 17 <= end) {
        const info = data[o++]!;
        const counts = data.subarray(o, o + 16);
        o += 16;
        let total = 0;
        for (let i = 0; i < 16; i++) total += counts[i]!;
        const symbols = data.subarray(o, o + total);
        o += total;
        const table = buildHuffman(counts, symbols);
        if (info >> 4 === 0) context.dcTables[info & 15] = table;
        else context.acTables[info & 15] = table;
      }
    } else if (context && marker === 0xdd) {
      context.restartInterval = u16(data, body);
    } else if (context && marker === 0xda) {
      if (!frame) throw new Error('corrupt JPEG: scan before frame header');
      if (++scans > MAX_SCANS) throw new Error(`unsupported JPEG: more than ${MAX_SCANS} scans`);
      at = context.onScan!(frame, at);
      continue;
    }
    at = end;
  }
  if (!frame) throw new Error('JPEG has no frame header');
  return { frame, adobeTransform, jfif };
}

// ---------------------------------------------------------------------------------------------------------
// Entropy decoding
// ---------------------------------------------------------------------------------------------------------

function decodeScan(data: Uint8Array, frame: Frame, context: DecodeContext, scanAt: number): number {
  const length = u16(data, scanAt);
  const count = data[scanAt + 2]!;
  const comps: Component[] = [];
  for (let i = 0; i < count; i++) {
    const id = data[scanAt + 3 + i * 2]!;
    const tables = data[scanAt + 4 + i * 2]!;
    const component = frame.components.find((c) => c.id === id) ?? frame.components[i];
    if (!component) throw new Error('corrupt JPEG: scan names an unknown component');
    component.dc = context.dcTables[tables >> 4] ?? null;
    component.ac = context.acTables[tables & 15] ?? null;
    component.quant = context.quantTables[component.tq] ?? component.quant;
    comps.push(component);
  }
  const ss = data[scanAt + 3 + count * 2]!;
  const se = data[scanAt + 4 + count * 2]!;
  const approximation = data[scanAt + 5 + count * 2]!;
  const ah = approximation >> 4;
  const al = approximation & 15;
  const entropyStart = scanAt + length;

  const dcOnly = context.dcOnly;
  const progressive = frame.progressive;
  if (progressive && dcOnly && ss > 0) return new BitReader(data, entropyStart).nextMarker();

  const stride = dcOnly ? 1 : 64;
  for (const c of comps) {
    c.coefficients ??= new Int16Array(c.blocksPerLineForMcu * c.blocksPerColumnForMcu * stride);
  }

  const reader = new BitReader(data, entropyStart);
  let eobrun = 0;

  const needDc = (c: Component): HuffmanTable => {
    if (!c.dc) throw new Error('corrupt JPEG: missing DC Huffman table');
    return c.dc;
  };
  const needAc = (c: Component): HuffmanTable => {
    if (!c.ac) throw new Error('corrupt JPEG: missing AC Huffman table');
    return c.ac;
  };

  const decodeBlock = (c: Component, base: number): void => {
    const coefficients = c.coefficients!;
    if (!progressive) {
      const t = reader.decode(needDc(c));
      c.pred += t === 0 ? 0 : reader.receive(t);
      coefficients[base] = c.pred;
      const ac = needAc(c);
      for (let k = 1; k < 64; ) {
        const rs = reader.decode(ac);
        const s = rs & 15;
        const r = rs >> 4;
        if (s === 0) {
          if (r < 15) break;
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        if (dcOnly) reader.bits(s);
        else coefficients[base + ZIGZAG[k]!] = reader.receive(s);
        k++;
      }
      return;
    }
    if (ss === 0) {
      if (ah === 0) {
        const t = reader.decode(needDc(c));
        c.pred += t === 0 ? 0 : reader.receive(t);
        coefficients[base] = c.pred * (1 << al);
      } else if (reader.bit()) {
        coefficients[base] = coefficients[base]! | (1 << al);
      }
      return;
    }
    const ac = needAc(c);
    if (ah === 0) {
      // first pass over a spectral band
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      for (let k = ss; k <= se; ) {
        const rs = reader.decode(ac);
        const s = rs & 15;
        const r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            eobrun = (1 << r) - 1 + (r > 0 ? reader.bits(r) : 0);
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        coefficients[base + ZIGZAG[k]!] = reader.receive(s) * (1 << al);
        k++;
      }
      return;
    }
    // successive approximation refinement (libjpeg's decode_mcu_AC_refine)
    const p1 = 1 << al;
    const m1 = -1 << al;
    let k = ss;
    if (eobrun === 0) {
      for (; k <= se; k++) {
        const rs = reader.decode(ac);
        let s = rs & 15;
        let r = rs >> 4;
        if (s !== 0) {
          s = reader.bit() ? p1 : m1;
        } else if (r !== 15) {
          eobrun = 1 << r;
          if (r > 0) eobrun += reader.bits(r);
          break;
        }
        while (k <= se) {
          const at = base + ZIGZAG[k]!;
          const value = coefficients[at]!;
          if (value !== 0) {
            if (reader.bit() && (value & p1) === 0) coefficients[at] = value + (value >= 0 ? p1 : m1);
          } else if (--r < 0) {
            break;
          }
          k++;
        }
        if (s !== 0 && k <= 63) coefficients[base + ZIGZAG[k]!] = s;
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) {
        const at = base + ZIGZAG[k]!;
        const value = coefficients[at]!;
        if (value !== 0 && reader.bit() && (value & p1) === 0) {
          coefficients[at] = value + (value >= 0 ? p1 : m1);
        }
      }
      eobrun--;
    }
  };

  const single = comps.length === 1;
  const first = comps[0]!;
  const totalMcus = single
    ? first.blocksPerLine * first.blocksPerColumn
    : frame.mcusPerLine * frame.mcusPerColumn;
  const interval = context.restartInterval > 0 ? context.restartInterval : totalMcus;

  let mcu = 0;
  while (mcu < totalMcus) {
    for (const c of comps) c.pred = 0;
    eobrun = 0;
    const intervalEnd = Math.min(totalMcus, mcu + interval);
    while (mcu < intervalEnd) {
      // the data is used up: the rest of the interval stays zero, like libjpeg does after "premature end of data"
      if (reader.starved) {
        mcu = intervalEnd;
        break;
      }
      if (single) {
        const row = Math.floor(mcu / first.blocksPerLine);
        const col = mcu % first.blocksPerLine;
        decodeBlock(first, (row * first.blocksPerLineForMcu + col) * stride);
      } else {
        const mcuRow = Math.floor(mcu / frame.mcusPerLine);
        const mcuCol = mcu % frame.mcusPerLine;
        for (const c of comps) {
          for (let v = 0; v < c.v; v++) {
            for (let h = 0; h < c.h; h++) {
              const row = mcuRow * c.v + v;
              const col = mcuCol * c.h + h;
              decodeBlock(c, (row * c.blocksPerLineForMcu + col) * stride);
            }
          }
        }
      }
      mcu++;
    }
    if (mcu < totalMcus) reader.restart();
  }
  return reader.nextMarker();
}

// ---------------------------------------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------------------------------------

/** `COS[x * 8 + u] = c(u) / 2 · cos((2x + 1) u π / 16)` */
const COS = new Float64Array(64);
for (let x = 0; x < 8; x++) {
  for (let u = 0; u < 8; u++) {
    COS[x * 8 + u] = ((u === 0 ? Math.SQRT1_2 : 1) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Planes per component: one sample per DC (scale 8) or one per pixel (scale 1). */
function buildPlane(c: Component, dcOnly: boolean): { data: Uint8Array; stride: number } {
  const quant = c.quant;
  if (!quant) throw new Error('corrupt JPEG: missing quantization table');
  const coefficients = c.coefficients!;
  const blocksX = c.blocksPerLineForMcu;
  const blocksY = c.blocksPerColumnForMcu;
  if (dcOnly) {
    const data = new Uint8Array(blocksX * blocksY);
    const q0 = quant[0]!;
    for (let i = 0; i < data.length; i++) data[i] = clamp8((coefficients[i]! * q0) / 8 + 128);
    return { data, stride: blocksX };
  }
  const stride = blocksX * 8;
  const data = new Uint8Array(stride * blocksY * 8);
  const block = new Float64Array(64);
  const temp = new Float64Array(64);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const base = (by * blocksX + bx) * 64;
      let flat = true;
      for (let i = 1; i < 64; i++) {
        if (coefficients[base + i] !== 0) {
          flat = false;
          break;
        }
      }
      if (flat) {
        // only a DC coefficient: the block is one value (exactly what the transform would produce)
        const value = clamp8((coefficients[base]! * quant[0]!) / 8 + 128);
        for (let y = 0; y < 8; y++)
          data.fill(value, (by * 8 + y) * stride + bx * 8, (by * 8 + y) * stride + bx * 8 + 8);
        continue;
      }
      for (let i = 0; i < 64; i++) block[i] = coefficients[base + i]! * quant[i]!;
      // rows: temp[v][x] = Σu COS[x][u] · block[v][u]
      for (let v = 0; v < 8; v++) {
        for (let x = 0; x < 8; x++) {
          let sum = 0;
          for (let u = 0; u < 8; u++) sum += COS[x * 8 + u]! * block[v * 8 + u]!;
          temp[v * 8 + x] = sum;
        }
      }
      // columns: out[y][x] = Σv COS[y][v] · temp[v][x]
      for (let y = 0; y < 8; y++) {
        const rowStart = (by * 8 + y) * stride + bx * 8;
        for (let x = 0; x < 8; x++) {
          let sum = 0;
          for (let v = 0; v < 8; v++) sum += COS[y * 8 + v]! * temp[v * 8 + x]!;
          data[rowStart + x] = clamp8(sum + 128);
        }
      }
    }
  }
  return { data, stride };
}

/** libjpeg's rules: JFIF means YCbCr, then the Adobe marker, then the component ids. */
function colourTransform(header: Header): 'gray' | 'ycbcr' | 'rgb' | 'cmyk' | 'ycck' {
  const { frame, adobeTransform, jfif } = header;
  const n = frame.components.length;
  if (n === 1) return 'gray';
  if (n === 4) {
    if (adobeTransform === null) return 'cmyk';
    return adobeTransform === 0 ? 'cmyk' : 'ycck';
  }
  if (jfif) return 'ycbcr';
  if (adobeTransform !== null) return adobeTransform === 0 ? 'rgb' : 'ycbcr';
  const ids = frame.components.map((c) => c.id);
  return ids[0] === 0x52 && ids[1] === 0x47 && ids[2] === 0x42 ? 'rgb' : 'ycbcr';
}

/** The decode reads only DC coefficients when the picture is at least 8× the target in both directions. */
export function jpegUsesDcOnly(
  info: Pick<JpegInfo, 'width' | 'height'>,
  target: { width: number; height: number },
  exact: boolean,
): boolean {
  return !exact && Math.ceil(info.width / 8) >= target.width && Math.ceil(info.height / 8) >= target.height;
}

/** Upper bound of the memory a decode holds: per component the coefficients (2 bytes) and the plane (1 byte). */
export function estimateJpegBytes(info: JpegInfo, dcOnly: boolean): number {
  const padded = (n: number) => n + 32;
  const samples = dcOnly
    ? padded(Math.ceil(info.width / 8)) * padded(Math.ceil(info.height / 8))
    : padded(info.width) * padded(info.height);
  return samples * 3 * info.components + (1 << 20);
}

/**
 * Decodes a JPEG into `sink`. When the picture is at least 8× the size of the requested target in both
 * directions only the DC coefficients are decoded and the delivered grid is `ceil(width / 8) × ceil(height / 8)`;
 * otherwise the full picture is delivered. Check `scale` in the result.
 */
export function decodeJpeg(
  data: Uint8Array,
  sink: RowSink,
  options: {
    targetWidth: number;
    targetHeight: number;
    maxPixels?: number;
    /** Largest working set in bytes (default 1 GiB). */
    maxBytes?: number;
    exact?: boolean;
  },
): JpegInfo & { scale: 1 | 8 } {
  const probed = probeJpeg(data);
  assertDimensions(probed.width, probed.height, options.maxPixels ?? DEFAULT_MAX_PIXELS);
  const dcOnly = jpegUsesDcOnly(
    probed,
    { width: options.targetWidth, height: options.targetHeight },
    options.exact === true,
  );
  const needed = estimateJpegBytes(probed, dcOnly);
  const budget = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (needed > budget) {
    throw new ImageLimitError(
      `decoding this ${probed.width}×${probed.height} picture ${dcOnly ? '' : 'completely '}needs about ${Math.round(needed / (1 << 20))} MB, above the limit of ${Math.round(budget / (1 << 20))} MB${dcOnly ? '' : " (accuracy 'fast' reads big pictures from their DC coefficients and needs far less)"}`,
    );
  }

  const context: DecodeContext = {
    dcOnly,
    quantTables: [],
    dcTables: [],
    acTables: [],
    restartInterval: 0,
    onScan: null,
  };
  context.onScan = (frame, at) => decodeScan(data, frame, context, at);
  const header = scan(data, context);
  const { frame } = header;
  if (!frame.components.some((c) => c.coefficients)) throw new Error('JPEG has no image data');
  for (const c of frame.components) {
    // a component whose scans are missing decodes as all zero (neutral chroma), like libjpeg
    c.coefficients ??= new Int16Array(c.blocksPerLineForMcu * c.blocksPerColumnForMcu * (dcOnly ? 1 : 64));
    c.quant ??= context.quantTables[c.tq] ?? null;
  }

  const planes = frame.components.map((c) => ({ c, ...buildPlane(c, dcOnly) }));
  const scale = dcOnly ? 8 : 1;
  const outWidth = Math.ceil(frame.width / scale);
  const outHeight = Math.ceil(frame.height / scale);
  const transform = colourTransform(header);
  const adobe = header.adobeTransform !== null;

  // Chroma planes are smaller than the picture. The full-resolution path samples them with the centred linear
  // interpolation libjpeg's "fancy upsampling" uses (output pixel x lies at (x + 0.5) · h / hMax − 0.5 in plane
  // samples); the DC grid replicates, like libjpeg does when it decodes at a reduced scale.
  interface Taps {
    i0: Int32Array;
    i1: Int32Array;
    w: Float64Array;
  }
  const taps = (count: number, factor: number, max: number, valid: number, interpolate: boolean): Taps => {
    const i0 = new Int32Array(count);
    const i1 = new Int32Array(count);
    const w = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      if (!interpolate) {
        i0[i] = i1[i] = Math.min(Math.floor((i * factor) / max), valid - 1);
        continue;
      }
      const f = ((i + 0.5) * factor) / max - 0.5;
      const base = Math.floor(f);
      i0[i] = Math.max(0, Math.min(valid - 1, base));
      i1[i] = Math.max(0, Math.min(valid - 1, base + 1));
      w[i] = f - base;
    }
    return { i0, i1, w };
  };
  // libjpeg-turbo interpolates ("fancy upsampling") only the 2:1 layouts h2v1, h2v2 and h1v2 (the first two only
  // when the chroma plane is wider than two samples) and replicates every other ratio.
  const layout = planes.map(({ c }) => {
    const hr = frame.hMax / c.h;
    const vr = frame.vMax / c.v;
    const validX = dcOnly ? c.blocksPerLine : Math.ceil((frame.width * c.h) / frame.hMax);
    const validY = dcOnly ? c.blocksPerColumn : Math.ceil((frame.height * c.v) / frame.vMax);
    const fancy =
      !dcOnly &&
      ((hr === 2 && vr === 1 && validX > 2) ||
        (hr === 2 && vr === 2 && validX > 2) ||
        (hr === 1 && vr === 2));
    return { hr, vr, validX, validY, fancy };
  });
  const columns = planes.map(({ c }, i) =>
    taps(outWidth, c.h, frame.hMax, layout[i]!.validX, layout[i]!.fancy && layout[i]!.hr === 2),
  );
  const lines = planes.map(({ c }, i) =>
    taps(outHeight, c.v, frame.vMax, layout[i]!.validY, layout[i]!.fancy && layout[i]!.vr === 2),
  );

  sink.begin(outWidth, outHeight, { cell: scale, width: frame.width, height: frame.height });
  const row = new Uint8Array(outWidth * 4);
  const sample = new Int32Array(4);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      for (let i = 0; i < planes.length; i++) {
        const { data, stride } = planes[i]!;
        const cx = columns[i]!;
        const ly = lines[i]!;
        const r0 = ly.i0[y]! * stride;
        const r1 = ly.i1[y]! * stride;
        const wx = cx.w[x]!;
        const wy = ly.w[y]!;
        const a = data[r0 + cx.i0[x]!]!;
        if (wx === 0 && wy === 0) {
          sample[i] = a;
          continue;
        }
        const top = a + (data[r0 + cx.i1[x]!]! - a) * wx;
        const bottomLeft = data[r1 + cx.i0[x]!]!;
        const bottom = bottomLeft + (data[r1 + cx.i1[x]!]! - bottomLeft) * wx;
        sample[i] = Math.round(top + (bottom - top) * wy);
      }
      let r: number;
      let g: number;
      let b: number;
      switch (transform) {
        case 'gray':
          r = g = b = sample[0]!;
          break;
        case 'rgb':
          r = sample[0]!;
          g = sample[1]!;
          b = sample[2]!;
          break;
        case 'ycbcr': {
          const yy = sample[0]!;
          const cb = sample[1]! - 128;
          const cr = sample[2]! - 128;
          r = clamp8(yy + 1.402 * cr);
          g = clamp8(yy - 0.344136 * cb - 0.714136 * cr);
          b = clamp8(yy + 1.772 * cb);
          break;
        }
        default: {
          // CMYK / YCCK. Adobe files store inverted ink, so the product of the stored values is the colour.
          let c = sample[0]!;
          let m = sample[1]!;
          let yy = sample[2]!;
          const k = sample[3]!;
          if (transform === 'ycck') {
            const cb = m - 128;
            const cr = yy - 128;
            const luma = c;
            c = 255 - clamp8(luma + 1.402 * cr);
            m = 255 - clamp8(luma - 0.344136 * cb - 0.714136 * cr);
            yy = 255 - clamp8(luma + 1.772 * cb);
          }
          if (adobe) {
            r = Math.round((c * k) / 255);
            g = Math.round((m * k) / 255);
            b = Math.round((yy * k) / 255);
          } else {
            r = Math.round(((255 - c) * (255 - k)) / 255);
            g = Math.round(((255 - m) * (255 - k)) / 255);
            b = Math.round(((255 - yy) * (255 - k)) / 255);
          }
        }
      }
      const o = x * 4;
      row[o] = r;
      row[o + 1] = g;
      row[o + 2] = b;
      row[o + 3] = 255;
    }
    sink.push(y, row);
  }
  return { ...probed, scale };
}
