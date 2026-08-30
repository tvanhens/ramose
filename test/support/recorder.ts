export interface RecordedHttpCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly status: number;
  readonly durationMs: number;
}

export interface RecordedFrame {
  readonly direction: "send" | "recv";
  readonly socketUrl: string;
  readonly payload: unknown;
  readonly at: number;
}

export interface RecordedSocket {
  readonly url: string;
  readonly closed: boolean;
  readonly frames: RecordedFrame[];
  close(code?: number, reason?: string): void;
}

export interface RecordingFetch {
  readonly fetch: typeof fetch;
  readonly calls: RecordedHttpCall[];
}

export interface RecordingWebSocket {
  readonly webSocket: typeof WebSocket;
  readonly sockets: RecordedSocket[];
  readonly frames: RecordedFrame[];
}

export interface RecordingTransport extends RecordingFetch, RecordingWebSocket {}

const headerMap = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

const parseBody = (text: string): unknown => {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const parseFrame = (data: unknown): unknown => {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
};

export const recordingFetch = (inner: typeof fetch = fetch.bind(globalThis)): RecordingFetch => {
  const calls: RecordedHttpCall[] = [];
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const started = Date.now();
    const request = input instanceof Request ? input : new Request(input, init);
    const bodyText = await request.clone().text();
    const response = await inner(request);
    calls.push({
      url: request.url,
      method: request.method,
      headers: headerMap(request.headers),
      body: parseBody(bodyText),
      status: response.status,
      durationMs: Date.now() - started,
    });
    return response;
  }) as typeof fetch;
  return { fetch: wrapped, calls };
};

export const recordingWebSocket = (
  Inner: typeof WebSocket = WebSocket,
): RecordingWebSocket => {
  const sockets: RecordedSocket[] = [];
  const frames: RecordedFrame[] = [];

  function Wrapped(this: unknown, url: string | URL, protocols?: string | string[]) {
    const socket = new Inner(url, protocols);
    const socketUrl = String(url);
    const recorded: RecordedSocket = {
      url: socketUrl,
      frames: [],
      get closed() {
        return socket.readyState === Inner.CLOSED;
      },
      close: (code, reason) => socket.close(code, reason),
    };
    const originalSend = socket.send.bind(socket);
    socket.send = ((data: string) => {
      const frame: RecordedFrame = {
        direction: "send",
        socketUrl,
        payload: parseFrame(data),
        at: Date.now(),
      };
      recorded.frames.push(frame);
      frames.push(frame);
      originalSend(data);
    }) as typeof socket.send;
    socket.addEventListener("message", (ev: MessageEvent) => {
      const frame: RecordedFrame = {
        direction: "recv",
        socketUrl,
        payload: parseFrame(ev.data),
        at: Date.now(),
      };
      recorded.frames.push(frame);
      frames.push(frame);
    });
    sockets.push(recorded);
    return socket;
  }

  return {
    webSocket: Wrapped as unknown as typeof WebSocket,
    sockets,
    frames,
  };
};

export const recordingTransport = (options?: {
  readonly fetch?: typeof fetch;
  readonly webSocket?: typeof WebSocket;
}): RecordingTransport => {
  const http = recordingFetch(options?.fetch);
  const ws = recordingWebSocket(options?.webSocket);
  return {
    fetch: http.fetch,
    calls: http.calls,
    webSocket: ws.webSocket,
    sockets: ws.sockets,
    frames: ws.frames,
  };
};
