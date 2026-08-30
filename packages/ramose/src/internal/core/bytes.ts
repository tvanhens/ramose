const ENC = new TextEncoder();
const DEC = new TextDecoder();

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(initial = 4096) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }

  u8(x: number): void {
    this.ensure(1);
    this.buf[this.pos++] = x & 0xff;
  }

  u32(x: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, x >>> 0, false);
    this.pos += 4;
  }

  uvar(x: number): void {
    if (x < 0 || !Number.isSafeInteger(x)) throw new RangeError(`uvar: bad value ${x}`);
    this.ensure(10);
    while (x >= 0x80) {
      this.buf[this.pos++] = (x % 0x80) | 0x80;
      x = Math.floor(x / 0x80);
    }
    this.buf[this.pos++] = x;
  }

  svar(x: number): void {
    if (!Number.isSafeInteger(x)) throw new RangeError(`svar: bad value ${x}`);
    const neg = x < 0 ? 1 : 0;
    const m = neg ? -x - 1 : x;
    const rest = Math.floor(m / 64);
    const low = ((m % 64) << 1) | neg;
    this.ensure(1);
    if (rest === 0) {
      this.buf[this.pos++] = low;
    } else {
      this.buf[this.pos++] = low | 0x80;
      this.uvar(rest);
    }
  }

  f64(x: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, x, false);
    this.pos += 8;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  lbytes(b: Uint8Array): void {
    this.uvar(b.length);
    this.bytes(b);
  }

  str(s: string): void {
    this.lbytes(ENC.encode(s));
  }

  reserve(n: number): number {
    this.ensure(n);
    const off = this.pos;
    this.pos += n;
    return off;
  }
  patchU32(off: number, x: number): void {
    this.view.setUint32(off, x >>> 0, false);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class ByteReader {
  pos: number;
  private view: DataView;
  constructor(readonly buf: Uint8Array, pos = 0) {
    this.pos = pos;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  u8(): number {
    if (this.pos >= this.buf.length) throw new RangeError("ByteReader: EOF");
    return this.buf[this.pos++];
  }
  u32(): number {
    const x = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return x;
  }
  uvar(): number {
    let result = 0;
    let mult = 1;
    for (;;) {
      if (this.pos >= this.buf.length) throw new RangeError("ByteReader: EOF in varint");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mult;
      if ((b & 0x80) === 0) return result;
      mult *= 0x80;
      if (mult > 2 ** 56) throw new RangeError("varint too long");
    }
  }
  svar(): number {
    const b = this.u8();
    const neg = b & 1;
    let m = (b >> 1) & 0x3f;
    if (b & 0x80) m += this.uvar() * 64;
    return neg ? -m - 1 : m;
  }
  f64(): number {
    const x = this.view.getFloat64(this.pos, false);
    this.pos += 8;
    return x;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new RangeError("ByteReader: EOF in bytes");
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  lbytes(): Uint8Array {
    return this.bytes(this.uvar());
  }
  str(): string {
    return DEC.decode(this.lbytes());
  }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const HEX = "0123456789abcdef";
export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15];
  return s;
}
export function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return toHex(new Uint8Array(digest));
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(new CompressionStream("gzip"), data);
}
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(new DecompressionStream("gzip"), data);
}
async function pipeThrough(ts: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }, data: Uint8Array): Promise<Uint8Array> {
  const w = ts.writable.getWriter();
  const written = w.write(data as BufferSource).then(() => w.close());
  const [buf] = await Promise.all([new Response(ts.readable).arrayBuffer(), written]);
  return new Uint8Array(buf);
}
