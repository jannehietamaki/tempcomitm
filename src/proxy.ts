/**
 * TCP MITM proxy for Tempco/Purmo heating system traffic.
 *
 * - HTTP port: parses requests/responses, emits events, supports response mutation
 * - HTTPS port: pure TCP passthrough (no TLS termination)
 */

import { createServer, Socket, Server } from 'node:net';
import { EventEmitter } from 'node:events';
import { HttpParser, ParsedRequest, ParsedResponse } from './http-parser.js';
import type { Config } from './config.js';

export interface Transaction {
  timestamp: string;
  clientAddress: string;
  request: ParsedRequest;
  response: ParsedResponse;
}

export type ResponseMutator = (path: string, body: string) => string | null;
export type RequestMutator = (path: string) => string | null;

export class TempcoProxy extends EventEmitter {
  private readonly config: Config;
  private httpServer: Server | null = null;
  private httpsServer: Server | null = null;
  private mutator: ResponseMutator | null = null;
  private requestMutator: RequestMutator | null = null;

  constructor(config: Config) {
    super();
    this.config = config;
  }

  /**
   * Register a callback that may mutate response bodies before they are
   * forwarded to the client.  The mutator receives the request path and
   * the original response body string.  Return a replacement string to
   * mutate, or null to leave the response untouched.
   */
  setResponseMutator(mutator: ResponseMutator): void {
    this.mutator = mutator;
  }

  setRequestMutator(mutator: RequestMutator): void {
    this.requestMutator = mutator;
  }

  /**
   * Start listening on both HTTP and HTTPS ports.
   */
  async start(): Promise<void> {
    await Promise.all([this.startHttp(), this.startHttps()]);
  }

  /**
   * Gracefully stop both servers.
   */
  async stop(): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this.httpServer) {
      promises.push(
        new Promise<void>((resolve) => this.httpServer!.close(() => resolve())),
      );
    }
    if (this.httpsServer) {
      promises.push(
        new Promise<void>((resolve) => this.httpsServer!.close(() => resolve())),
      );
    }
    await Promise.all(promises);
    this.httpServer = null;
    this.httpsServer = null;
  }

  // ── HTTP proxy (parsed) ──────────────────────────────────────────────

  private startHttp(): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;

      this.httpServer = createServer((clientSocket) => {
        this.handleHttpConnection(clientSocket);
      });

      this.httpServer.on('error', (err) => {
        if (!started) {
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      this.httpServer.listen(
        this.config.httpPort,
        this.config.listenHost,
        () => {
          started = true;
          console.log(
            `[proxy] HTTP listening on ${this.config.listenHost}:${this.config.httpPort} -> ${this.config.upstreamHost}:${this.config.upstreamHttpPort}`,
          );
          resolve();
        },
      );
    });
  }

  private handleHttpConnection(clientSocket: Socket): void {
    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    console.log(`[proxy] connection from ${clientAddr}`);

    const upstreamSocket = new Socket();
    upstreamSocket.connect(
      this.config.upstreamHttpPort,
      this.config.upstreamHost,
    );

    const reqParser = new HttpParser();
    const respParser = new HttpParser();
    const pendingRequests: ParsedRequest[] = [];

    // Client -> Upstream (parse first, mutate if needed, then forward)
    clientSocket.on('data', (chunk: Buffer) => {
      try {
        reqParser.feedData(chunk);
        let req: ParsedRequest | null;
        let forwarded = false;
        while ((req = reqParser.getRequest()) !== null) {
          console.log(`[proxy] ${clientAddr} ${req.method} ${req.path.substring(0, 120)}`);

          // Try to mutate the request path (e.g. inject pending values)
          const mutatedPath = this.requestMutator?.(req.path) ?? null;
          if (mutatedPath !== null) {
            const mutatedRaw = rebuildRequestRaw(req.raw, mutatedPath);
            try { upstreamSocket.write(mutatedRaw); } catch { /* closed */ }
            console.log(`[proxy] mutated request for ${clientAddr}`);
          } else {
            try { upstreamSocket.write(req.raw); } catch { /* closed */ }
          }
          forwarded = true;

          pendingRequests.push(req);
          this.emit('request', req, clientAddr);
          // Always emit deviceEdit from the ORIGINAL path (what the controller sent)
          // so we can detect when the controller actually accepts the new value
          this.maybeEmitDeviceEdit(req.path);
        }
        // Forward any remaining buffered data that hasn't formed a complete request yet
        if (!forwarded && reqParser.bufferedBytes > 0) {
          // Data is being buffered; will be forwarded when complete
        } else if (!forwarded) {
          // No complete request parsed - forward raw chunk to keep connection alive
          try { upstreamSocket.write(chunk); } catch { /* closed */ }
        }
      } catch (err) {
        console.error(`[proxy] parse error from ${clientAddr}: ${err}`);
        this.emit('error', new Error(`Request parse error: ${err}`));
        // Fallback: forward raw data so connection isn't broken
        try { upstreamSocket.write(chunk); } catch { /* closed */ }
      }
    });

    // Upstream -> Client
    upstreamSocket.on('data', (chunk: Buffer) => {
      try {
        respParser.feedData(chunk);
        let resp: ParsedResponse | null;
        while ((resp = respParser.getResponse()) !== null) {
          const matchedReq = pendingRequests.shift();

          // Log response bodies for debugging
          const reqPath = matchedReq?.path ?? '';
          if (reqPath.includes('/machine/')) {
            console.log(`[proxy] <-- ${resp.status} ${reqPath.substring(0, 80)}`);
            console.log(`[proxy] body: ${resp.body.substring(0, 500)}`);
          }

          // Possibly mutate the response body
          const outbound = this.maybeApplyMutation(matchedReq, resp);

          try {
            clientSocket.write(outbound.raw);
          } catch {
            // client may already be closed
          }

          this.emit('response', outbound, clientAddr);

          if (matchedReq) {
            const transaction: Transaction = {
              timestamp: new Date().toISOString(),
              clientAddress: clientAddr,
              request: matchedReq,
              response: outbound,
            };
            this.emit('transaction', transaction);
          }
        }

        // If the parser has not yielded a complete response, forward
        // the raw data directly so the client is not stalled.  This
        // handles the case where a response is still being received.
        if (respParser.bufferedBytes > 0) {
          // Data is being buffered inside the parser; the client will
          // receive it once the full response is parsed.  Nothing to
          // do here -- the parser will yield it on the next chunk.
        }
      } catch (err) {
        // Fallback: if parsing fails entirely, forward raw data so
        // the connection is not broken.
        try {
          clientSocket.write(chunk);
        } catch {
          // ignore
        }
        this.emit('error', new Error(`Response parse error: ${err}`));
      }
    });

    // Error / close handling
    const cleanup = () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    };

    clientSocket.on('error', (err) => {
      console.log(`[proxy] client error (${clientAddr}): ${err.message}`);
      cleanup();
    });

    upstreamSocket.on('error', (err) => {
      console.log(`[proxy] upstream error (${clientAddr}): ${err.message}`);
      cleanup();
    });

    clientSocket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => clientSocket.destroy());

    clientSocket.on('end', () => {
      try {
        upstreamSocket.end();
      } catch {
        // ignore
      }
    });

    upstreamSocket.on('end', () => {
      try {
        clientSocket.end();
      } catch {
        // ignore
      }
    });
  }

  /**
   * Apply the registered response mutator, if any.  Returns the
   * (possibly modified) ParsedResponse with an updated raw buffer.
   */
  private maybeApplyMutation(
    req: ParsedRequest | undefined,
    resp: ParsedResponse,
  ): ParsedResponse {
    if (!this.mutator || !req) return resp;

    try {
      const replacement = this.mutator(req.path, resp.body);
      if (replacement === null) return resp;

      const newBody = Buffer.from(replacement, 'latin1');
      const newRaw = rebuildResponseRaw(resp.raw, newBody);

      return {
        ...resp,
        body: replacement,
        raw: newRaw,
      };
    } catch (err) {
      this.emit('error', new Error(`Mutator error: ${err}`));
      return resp;
    }
  }

  /**
   * If the path contains /machine/device/edit/, extract the JSON
   * payload from the URL and emit a 'deviceEdit' event.
   */
  private maybeEmitDeviceEdit(path: string): void {
    const marker = '/machine/device/edit/';
    const idx = path.indexOf(marker);
    if (idx === -1) return;

    const raw = path.substring(idx + marker.length);
    try {
      const decoded = decodeURIComponent(raw);
      const payload = JSON.parse(decoded);
      this.emit('deviceEdit', { payload, timestamp: new Date().toISOString() });
    } catch {
      // not valid JSON -- ignore
    }
  }

  // ── HTTPS proxy (passthrough) ────────────────────────────────────────

  private startHttps(): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;

      this.httpsServer = createServer((clientSocket) => {
        this.handleHttpsConnection(clientSocket);
      });

      this.httpsServer.on('error', (err) => {
        if (!started) {
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      this.httpsServer.listen(
        this.config.httpsPort,
        this.config.listenHost,
        () => {
          started = true;
          console.log(
            `[proxy] HTTPS listening on ${this.config.listenHost}:${this.config.httpsPort} -> ${this.config.upstreamHttpsHost}:${this.config.upstreamHttpsPort}`,
          );
          resolve();
        },
      );
    });
  }

  private handleHttpsConnection(clientSocket: Socket): void {
    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;

    const upstreamSocket = new Socket();
    upstreamSocket.connect(
      this.config.upstreamHttpsPort,
      this.config.upstreamHttpsHost,
    );

    // Pure bidirectional pipe -- no parsing
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);

    const cleanup = () => {
      clientSocket.unpipe(upstreamSocket);
      upstreamSocket.unpipe(clientSocket);
      clientSocket.destroy();
      upstreamSocket.destroy();
    };

    clientSocket.on('error', () => {
      cleanup();
    });

    upstreamSocket.on('error', () => {
      cleanup();
    });

    clientSocket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => clientSocket.destroy());
  }
}

// ── Utility ──────────────────────────────────────────────────────────────

/**
 * Rebuild a raw HTTP response buffer with a new body, updating the
 * Content-Length header accordingly.
 */
function rebuildResponseRaw(originalRaw: Buffer, newBody: Buffer): Buffer {
  const boundaryIdx = originalRaw.indexOf('\r\n\r\n');
  if (boundaryIdx === -1) {
    // Malformed -- just return newBody with a minimal header
    return Buffer.concat([
      Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: ' + newBody.length + '\r\n\r\n', 'latin1'),
      newBody,
    ]);
  }

  const headerBlock = originalRaw.subarray(0, boundaryIdx).toString('latin1');
  const lines = headerBlock.split('\r\n');
  const startLine = lines[0];
  const newLines: string[] = [startLine];
  let replacedCL = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.toLowerCase().startsWith('content-length:')) {
      newLines.push(`Content-Length: ${newBody.length}`);
      replacedCL = true;
    } else {
      newLines.push(line);
    }
  }

  if (!replacedCL) {
    newLines.push(`Content-Length: ${newBody.length}`);
  }

  const newHeader = Buffer.from(newLines.join('\r\n') + '\r\n\r\n', 'latin1');
  return Buffer.concat([newHeader, newBody]);
}

/**
 * Rebuild a raw HTTP request buffer with a new path, replacing the
 * request line while preserving headers and body.
 */
function rebuildRequestRaw(originalRaw: Buffer, newPath: string): Buffer {
  const headerStr = originalRaw.toString('latin1');
  const firstLineEnd = headerStr.indexOf('\r\n');
  if (firstLineEnd === -1) return originalRaw;

  const firstLine = headerStr.substring(0, firstLineEnd);
  const parts = firstLine.split(' ', 3);
  if (parts.length < 3) return originalRaw;

  const newFirstLine = `${parts[0]} ${newPath} ${parts[2]}`;
  return Buffer.from(
    newFirstLine + headerStr.substring(firstLineEnd),
    'latin1',
  );
}
