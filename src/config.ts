/**
 * Configuration module for the Tempco/Purmo MITM proxy.
 * Reads from environment variables with sensible defaults.
 */

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export interface Config {
  listenHost: string;
  httpPort: number;
  httpsPort: number;
  upstreamHost: string;
  upstreamHostname: string;
  upstreamHttpPort: number;
  upstreamHttpsHost: string;
  upstreamHttpsPort: number;
  webPort: number;
  logDir: string;
  disableLog: boolean;
  stateDir: string;
  mqttUrl: string;
  mqttPrefix: string;
}

export const config: Config = {
  listenHost: envStr('TEMPCO_LISTEN_HOST', '0.0.0.0'),
  httpPort: envInt('TEMPCO_HTTP_PORT', 80),
  httpsPort: envInt('TEMPCO_HTTPS_PORT', 443),
  upstreamHost: envStr('TEMPCO_UPSTREAM_HOST', '108.142.40.45'),
  upstreamHostname: envStr('TEMPCO_UPSTREAM_HOSTNAME', 'e3.lvi.eu'),
  upstreamHttpPort: envInt('TEMPCO_UPSTREAM_HTTP_PORT', 80),
  upstreamHttpsHost: envStr('TEMPCO_UPSTREAM_HTTPS_HOST', '108.142.40.45'),
  upstreamHttpsPort: envInt('TEMPCO_UPSTREAM_HTTPS_PORT', 443),
  webPort: envInt('TEMPCO_WEB_PORT', 3000),
  logDir: envStr('TEMPCO_LOG_DIR', 'logs'),
  disableLog: envBool('TEMPCO_DISABLE_LOG', false),
  stateDir: envStr('TEMPCO_STATE_DIR', 'state'),
  mqttUrl: envStr('TEMPCO_MQTT_URL', 'mqtt://localhost:1883'),
  mqttPrefix: envStr('TEMPCO_MQTT_PREFIX', 'tempco'),
};
