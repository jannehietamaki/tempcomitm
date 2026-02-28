/**
 * Streaming HTTP message parser for raw TCP data.
 *
 * Handles Content-Length based body extraction, incomplete message buffering,
 * and tolerant parsing of non-ASCII / malformed data using latin1 encoding.
 */

export interface ParsedRequest {
  method: string;
  path: string;
  version: string;
  headers: Record<string, string>;
  body: string;
  raw: Buffer;
}

export interface ParsedResponse {
  version: string;
  status: number;
  reason: string;
  headers: Record<string, string>;
  body: string;
  raw: Buffer;
}

interface RawMessage {
  startLine: string;
  headers: Record<string, string>;
  body: Buffer;
  raw: Buffer;
}

const HEADER_BOUNDARY = Buffer.from('\r\n\r\n');

export class HttpParser {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Feed a chunk of TCP data into the parser buffer.
   */
  feedData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  /**
   * Attempt to extract and return a parsed HTTP request from the buffer.
   * Returns null if a complete message has not yet been received.
   */
  getRequest(): ParsedRequest | null {
    const msg = this.extractMessage();
    if (!msg) return null;

    const { method, path, version } = parseRequestLine(msg.startLine);
    return {
      method,
      path,
      version,
      headers: msg.headers,
      body: msg.body.toString('latin1'),
      raw: msg.raw,
    };
  }

  /**
   * Attempt to extract and return a parsed HTTP response from the buffer.
   * Returns null if a complete message has not yet been received.
   */
  getResponse(): ParsedResponse | null {
    const msg = this.extractMessage();
    if (!msg) return null;

    const { version, status, reason } = parseStatusLine(msg.startLine);
    return {
      version,
      status,
      reason,
      headers: msg.headers,
      body: msg.body.toString('latin1'),
      raw: msg.raw,
    };
  }

  /**
   * Reset the internal buffer, discarding any partial data.
   */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Return the number of bytes currently buffered.
   */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  // ── Private ────────────────────────────────────────────────────────

  /**
   * Try to extract one complete HTTP message from the buffer.
   * Returns null if incomplete; consumes the bytes on success.
   */
  private extractMessage(): RawMessage | null {
    const headerEnd = bufferIndexOf(this.buffer, HEADER_BOUNDARY);
    if (headerEnd === -1) return null;

    const headerBlock = this.buffer.subarray(0, headerEnd + HEADER_BOUNDARY.length);
    const lines = headerBlock.toString('latin1').split('\r\n');

    const startLine = lines[0] ?? '';
    const headers: Record<string, string> = {};

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const name = line.substring(0, colonIdx).trim().toLowerCase();
      const value = line.substring(colonIdx + 1).trim();
      headers[name] = value;
    }

    const contentLength = parseInt(headers['content-length'] ?? '0', 10) || 0;
    const totalLength = headerEnd + HEADER_BOUNDARY.length + contentLength;

    if (this.buffer.length < totalLength) {
      // Body not fully received yet
      return null;
    }

    const body = this.buffer.subarray(
      headerEnd + HEADER_BOUNDARY.length,
      totalLength,
    );
    const raw = this.buffer.subarray(0, totalLength);

    // Consume the message from the buffer
    this.buffer = this.buffer.subarray(totalLength);

    return {
      startLine,
      headers,
      body: Buffer.from(body),
      raw: Buffer.from(raw),
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Find the index of a needle buffer inside a haystack buffer.
 * Returns -1 if not found.
 */
function bufferIndexOf(haystack: Buffer, needle: Buffer): number {
  return haystack.indexOf(needle);
}

/**
 * Parse an HTTP request line like "GET /path HTTP/1.1".
 */
function parseRequestLine(line: string): {
  method: string;
  path: string;
  version: string;
} {
  const parts = line.split(' ', 3);
  return {
    method: parts[0] ?? '',
    path: parts[1] ?? '',
    version: parts[2] ?? '',
  };
}

/**
 * Parse an HTTP status line like "HTTP/1.1 200 OK".
 */
function parseStatusLine(line: string): {
  version: string;
  status: number;
  reason: string;
} {
  const firstSpace = line.indexOf(' ');
  if (firstSpace === -1) {
    return { version: line, status: 0, reason: '' };
  }
  const version = line.substring(0, firstSpace);
  const rest = line.substring(firstSpace + 1);
  const secondSpace = rest.indexOf(' ');
  if (secondSpace === -1) {
    return { version, status: parseInt(rest, 10) || 0, reason: '' };
  }
  const status = parseInt(rest.substring(0, secondSpace), 10) || 0;
  const reason = rest.substring(secondSpace + 1);
  return { version, status, reason };
}
