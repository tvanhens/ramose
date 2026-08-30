import { ValueTag } from "../datom.ts";

export class EdnList {
  constructor(readonly items: unknown[]) {}
}

export class EdnConst {
  constructor(readonly value: unknown) {}
}
export function isEdnConstWrapper(x: unknown): x is EdnConst | { const: unknown } {
  return x instanceof EdnConst || (typeof x === "object" && x !== null && "const" in (x as any) && Object.keys(x as any).length === 1);
}
export function unwrapEdnConst(x: EdnConst | { const: unknown }): unknown {
  return x instanceof EdnConst ? x.value : (x as any).const;
}

export function looksLikeSymbol(s: string): boolean {
  return s.length > 0 && (s[0] === "?" || s[0] === ":" || s[0] === "$" || s === "_" || s[0] === "%");
}

const WS = /\s|,/;

export function readEdn(src: string): unknown {
  const r = new Reader(src);
  const v = r.read();
  r.skipWs();
  if (!r.eof()) throw new SyntaxError(`EDN: trailing input at ${r.pos}: ${src.slice(r.pos, r.pos + 20)}`);
  return v;
}

export function readEdnAll(src: string): unknown[] {
  const r = new Reader(src);
  const out: unknown[] = [];
  for (;;) {
    r.skipWs();
    if (r.eof()) return out;
    out.push(r.read());
  }
}

class Reader {
  pos = 0;
  constructor(readonly s: string) {}

  eof(): boolean {
    return this.pos >= this.s.length;
  }
  peek(): string {
    return this.s[this.pos];
  }
  skipWs(): void {
    for (;;) {
      while (!this.eof() && WS.test(this.s[this.pos])) this.pos++;
      if (!this.eof() && this.s[this.pos] === ";") {
        while (!this.eof() && this.s[this.pos] !== "\n") this.pos++;
        continue;
      }
      return;
    }
  }

  read(): unknown {
    this.skipWs();
    if (this.eof()) throw new SyntaxError("EDN: unexpected end of input");
    const c = this.peek();
    switch (c) {
      case "[":
        this.pos++;
        return this.readSeq("]");
      case "(":
        this.pos++;
        return new EdnList(this.readSeq(")"));
      case "{":
        this.pos++;
        return this.readMap();
      case '"':
        return this.readString();
      case "#": {
        if (this.s[this.pos + 1] === "{") {
          this.pos += 2;
          return new Set(this.readSeq("}"));
        }
        if (this.s[this.pos + 1] === "_") {
          this.pos += 2;
          this.read();
          return this.read();
        }
        this.pos++;
        const tag = this.readToken();
        const val = this.read();
        return this.tagged(tag, val);
      }
      case "\\": {
        this.pos++;
        const tok = this.readToken();
        const map: Record<string, string> = { newline: "\n", space: " ", tab: "\t", return: "\r" };
        return map[tok] ?? tok;
      }
      default: {
        const tok = this.readToken();
        return this.atom(tok);
      }
    }
  }

  private tagged(tag: string, val: unknown): unknown {
    switch (tag) {
      case "inst":
        return new Date(val as string);
      case "uuid":
        return { vt: ValueTag.Uuid, v: (val as string).toLowerCase() };
      case "bytes": {
        const bin = atob(val as string);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      default:
        throw new SyntaxError(`EDN: unknown tag #${tag}`);
    }
  }

  private readSeq(close: string): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      this.skipWs();
      if (this.eof()) throw new SyntaxError(`EDN: unterminated sequence, expected ${close}`);
      if (this.peek() === close) {
        this.pos++;
        return out;
      }
      out.push(this.read());
    }
  }

  private readMap(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skipWs();
      if (this.eof()) throw new SyntaxError("EDN: unterminated map");
      if (this.peek() === "}") {
        this.pos++;
        return out;
      }
      const k = this.read();
      const v = this.read();
      out[typeof k === "string" ? k : JSON.stringify(k)] = v;
    }
  }

  private readString(): unknown {
    this.pos++;
    let out = "";
    for (;;) {
      if (this.eof()) throw new SyntaxError("EDN: unterminated string");
      const c = this.s[this.pos++];
      if (c === '"') break;
      if (c === "\\") {
        const n = this.s[this.pos++];
        switch (n) {
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "u": {
            out += String.fromCharCode(parseInt(this.s.substr(this.pos, 4), 16));
            this.pos += 4;
            break;
          }
          default: out += n;
        }
      } else out += c;
    }
    return looksLikeSymbol(out) ? new EdnConst(out) : out;
  }

  private readToken(): string {
    const start = this.pos;
    while (!this.eof()) {
      const c = this.s[this.pos];
      if (WS.test(c) || c === "[" || c === "]" || c === "(" || c === ")" || c === "{" || c === "}" || c === '"' || c === ";") break;
      this.pos++;
    }
    if (this.pos === start) throw new SyntaxError(`EDN: unexpected character '${this.s[start]}' at ${start}`);
    return this.s.slice(start, this.pos);
  }

  private atom(tok: string): unknown {
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (tok === "nil") return null;
    if (/^[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+)[MN]?$/.test(tok)) {
      const n = Number(tok.replace(/[MN]$/, ""));
      return n;
    }
    return tok;
  }
}

export function printEdn(v: unknown): string {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "string") return looksLikeSymbol(v) ? v : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof EdnConst) return JSON.stringify(v.value);
  if (v instanceof Date) return `#inst "${v.toISOString()}"`;
  if (v instanceof EdnList) return "(" + v.items.map(printEdn).join(" ") + ")";
  if (Array.isArray(v)) return "[" + v.map(printEdn).join(" ") + "]";
  if (v instanceof Set) return "#{" + [...v].map(printEdn).join(" ") + "}";
  if (v instanceof Uint8Array) return `#bytes "${btoa(String.fromCharCode(...v))}"`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("vt" in o && o.vt === ValueTag.Uuid) return `#uuid "${o.v}"`;
    return "{" + Object.entries(o).map(([k, val]) => `${printEdn(k)} ${printEdn(val)}`).join(" ") + "}";
  }
  return String(v);
}
