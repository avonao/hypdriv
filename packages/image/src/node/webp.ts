/**
 * Just enough of the WebP container to learn a picture's size before the WebAssembly decoder allocates it,
 * and to cut the first frame out of an animation (libwebp's still-image decoder rejects those).
 */

export interface WebpInfo {
  width: number;
  height: number;
  animated: boolean;
}

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const u24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/** Dimensions of the bitstream chunk at `at` (`VP8 ` or `VP8L`), or `null` for anything else. */
function bitstreamSize(
  b: Uint8Array,
  type: string,
  payload: number,
): { width: number; height: number } | null {
  if (type === 'VP8 ' && payload + 10 <= b.length && b[payload + 3] === 0x9d && b[payload + 4] === 0x01) {
    return {
      width: (b[payload + 6]! | (b[payload + 7]! << 8)) & 0x3fff,
      height: (b[payload + 8]! | (b[payload + 9]! << 8)) & 0x3fff,
    };
  }
  if (type === 'VP8L' && payload + 5 <= b.length && b[payload] === 0x2f) {
    const bits = u32(b, payload + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** Reads the canvas size from the header chunks; `null` when the bytes are not a WebP file. */
export function probeWebp(b: Uint8Array): WebpInfo | null {
  if (b.length < 20 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') return null;
  let at = 12;
  let canvas: { width: number; height: number } | null = null;
  let animated = false;
  while (at + 8 <= b.length) {
    const type = fourcc(b, at);
    const size = u32(b, at + 4);
    const payload = at + 8;
    if (type === 'VP8X' && payload + 10 <= b.length) {
      animated = (b[payload]! & 0x02) !== 0;
      canvas = { width: u24(b, payload + 4) + 1, height: u24(b, payload + 7) + 1 };
    } else {
      const still = bitstreamSize(b, type, payload);
      if (still) return canvas ? { ...canvas, animated } : { ...still, animated: false };
      if (type === 'ANMF' || type === 'ANIM') return canvas ? { ...canvas, animated } : null;
    }
    at = payload + size + (size & 1);
  }
  return canvas ? { ...canvas, animated } : null;
}

/**
 * The first frame of an animated WebP as a stand-alone still file (`VP8X` + the frame's `ALPH`/`VP8`/`VP8L`
 * chunks), or `null` when there is none. The frame is not composited onto the canvas: a placeholder wants the
 * picture, not the animation's blending.
 */
export function firstWebpFrame(b: Uint8Array): Uint8Array | null {
  if (b.length < 20 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') return null;
  let at = 12;
  while (at + 8 <= b.length) {
    const type = fourcc(b, at);
    const size = u32(b, at + 4);
    const payload = at + 8;
    if (type === 'ANMF' && size >= 16 && payload + size <= b.length) {
      const width = u24(b, payload + 6) + 1;
      const height = u24(b, payload + 9) + 1;
      const frame = b.subarray(payload + 16, payload + size);
      let hasAlpha = false;
      for (let o = 0; o + 8 <= frame.length; ) {
        const sub = fourcc(frame, o);
        if (sub === 'ALPH' || sub === 'VP8L') hasAlpha = true;
        o += 8 + u32(frame, o + 4) + (u32(frame, o + 4) & 1);
      }
      const out = new Uint8Array(12 + 18 + frame.length);
      const view = new DataView(out.buffer);
      out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
      view.setUint32(4, out.length - 8, true);
      out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
      out.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
      view.setUint32(16, 10, true);
      out[20] = hasAlpha ? 0x10 : 0;
      out[24] = (width - 1) & 0xff;
      out[25] = ((width - 1) >> 8) & 0xff;
      out[26] = ((width - 1) >> 16) & 0xff;
      out[27] = (height - 1) & 0xff;
      out[28] = ((height - 1) >> 8) & 0xff;
      out[29] = ((height - 1) >> 16) & 0xff;
      out.set(frame, 30);
      return out;
    }
    at = payload + size + (size & 1);
  }
  return null;
}
