/**
 * Web server for the Tempco/Purmo heating dashboard.
 *
 * Provides a single-page UI dashboard and a REST API for viewing and
 * controlling radiator zones.  Uses only the built-in `node:http` module.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { rawToCelsius } from '../temperature.js';

// ── Types ────────────────────────────────────────────────────

export interface DeviceState {
  label: string;
  reported_label: string;
  zone_label: string;
  num_zone: string;
  mode_code: string;
  comfort: string;
  frost: string;
  eco: string;
  boost: string;
  manual: string;
  min_set: string;
  max_set: string;
  time_boost: string;
  flag22: string;
  power: string;
  temperature_air: string;
  schedule: string;
  last_update: string;
}

export interface StateManager {
  getAllDevices(): Record<string, DeviceState>;
  getDevice(id: string): DeviceState | undefined;
  isPending(id: string): boolean;
}

export interface WebServerEvents {
  setTemperature: [deviceId: string, celsius: number];
  setHoliday: [deviceId: string, on: boolean];
}

// ── Helpers ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const maxSize = 1024 * 64; // 64 KB limit

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', reject);
  });
}

/**
 * Parse a simple route pattern and extract path parameters.
 * Supports patterns like `/api/devices/:id/temperature`.
 */
function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const val = pathParts[i]!;

    if (pp.startsWith(':')) {
      params[pp.slice(1)] = decodeURIComponent(val);
    } else if (pp !== val) {
      return null;
    }
  }

  return params;
}

/**
 * Add celsius conversions to a device state object for API responses.
 */
function enrichDeviceState(
  id: string,
  state: DeviceState,
  pending: boolean,
): Record<string, unknown> {
  return {
    id,
    ...state,
    pending_confirmation: pending,
    temperature_air_celsius: rawToCelsius(state.temperature_air),
    comfort_celsius: rawToCelsius(state.comfort),
    frost_celsius: rawToCelsius(state.frost),
    eco_celsius: rawToCelsius(state.eco),
    boost_celsius: rawToCelsius(state.boost),
    manual_celsius: rawToCelsius(state.manual),
    min_set_celsius: rawToCelsius(state.min_set),
    max_set_celsius: rawToCelsius(state.max_set),
    power_watts: parseInt(state.power, 10) || 0,
    holiday: state.flag22 === '2',
  };
}

// ── WebServer ────────────────────────────────────────────────

export class WebServer extends EventEmitter {
  private readonly port: number;
  private readonly stateManager: StateManager;
  private readonly html: string;
  private server: Server | null = null;

  constructor(port: number, stateManager: StateManager) {
    super();
    this.port = port;
    this.stateManager = stateManager;

    // Read the HTML file once at startup
    const htmlPath = join(__dirname, 'index.html');
    this.html = readFileSync(htmlPath, 'utf-8');
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error('[web] unhandled error:', err);
          if (!res.headersSent) {
            sendJson(res, 500, { error: 'Internal server error' });
          }
        });
      });

      this.server.on('error', (err) => {
        console.error('[web] server error:', err);
        reject(err);
      });

      this.server.listen(this.port, () => {
        console.log(`[web] listening on http://0.0.0.0:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.server = null;
        console.log('[web] stopped');
        resolve();
      });
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    setCorsHeaders(res);

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── GET / ── Dashboard HTML ──────────────────────────────
    if (method === 'GET' && pathname === '/') {
      sendHtml(res, this.html);
      return;
    }

    // ── GET /api/health ──────────────────────────────────────
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // ── GET /api/devices ─────────────────────────────────────
    if (method === 'GET' && pathname === '/api/devices') {
      const all = this.stateManager.getAllDevices();
      const enriched: Record<string, unknown> = {};

      for (const [id, state] of Object.entries(all)) {
        enriched[id] = enrichDeviceState(id, state, this.stateManager.isPending(id));
      }

      sendJson(res, 200, enriched);
      return;
    }

    // ── POST /api/devices/:id/temperature ────────────────────
    const tempParams = matchRoute('/api/devices/:id/temperature', pathname);
    if (method === 'POST' && tempParams) {
      const deviceId = tempParams.id!;

      // Verify device exists
      const device = this.stateManager.getDevice(deviceId);
      if (!device) {
        sendJson(res, 404, { error: `Device ${deviceId} not found` });
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 400, { error: 'Failed to read request body' });
        return;
      }

      let parsed: { celsius?: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      const celsius = Number(parsed.celsius);
      if (!Number.isFinite(celsius) || celsius < 5 || celsius > 35) {
        sendJson(res, 400, {
          error: 'Invalid temperature. Must be a number between 5 and 35.',
        });
        return;
      }

      console.log(`[web] command: set temperature ${deviceId} -> ${celsius}C`);
      this.emit('setTemperature', deviceId, celsius);
      sendJson(res, 200, { ok: true, deviceId, celsius });
      return;
    }

    // ── POST /api/devices/:id/holiday ────────────────────────
    const holidayParams = matchRoute('/api/devices/:id/holiday', pathname);
    if (method === 'POST' && holidayParams) {
      const deviceId = holidayParams.id!;

      const device = this.stateManager.getDevice(deviceId);
      if (!device) {
        sendJson(res, 404, { error: `Device ${deviceId} not found` });
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 400, { error: 'Failed to read request body' });
        return;
      }

      let parsed: { on?: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      if (typeof parsed.on !== 'boolean') {
        sendJson(res, 400, { error: 'Field "on" must be a boolean' });
        return;
      }

      console.log(`[web] command: set holiday ${deviceId} -> ${parsed.on}`);
      this.emit('setHoliday', deviceId, parsed.on);
      sendJson(res, 200, { ok: true, deviceId, holiday: parsed.on });
      return;
    }

    // ── 404 ──────────────────────────────────────────────────
    sendJson(res, 404, { error: 'Not found' });
  }
}
