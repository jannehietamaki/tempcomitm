import http from 'node:http';
import { TempcoProxy } from './proxy.js';
import { StateManager } from './state.js';
import { MqttBridge } from './mqtt.js';
import { WebServer } from './web/server.js';
import { TransactionLogger } from './logger.js';
import { rawToCelsius, celsiusToRaw } from './temperature.js';
import { flag22ToMode, getTargetKey } from './modes.js';
import { config } from './config.js';

async function main() {
  console.log('tempcomitm - Tempco/Purmo Heating System Proxy');
  console.log('============================================');

  // Initialize state manager
  const state = new StateManager(config.stateDir);
  state.load();

  // Initialize transaction logger
  const logger = new TransactionLogger(config.logDir, config.disableLog);

  // Initialize proxy
  const proxy = new TempcoProxy(config);

  // Wire up: proxy transactions -> logger
  proxy.on('transaction', (tx) => logger.log(tx));

  // Inject pending commands into query/check responses.
  //
  // Strategy per device:
  //   1. Inject once into query/check + send upstream device/edit
  //   2. Watch device/edit reports — count consecutive matching values
  //   3. If a report reverts to wrong value → re-inject once, reset counter
  //   4. After 3 consecutive correct reports → fully confirmed, move to next device
  //
  // Only one device is actively being set at a time.
  const CONFIRM_THRESHOLD = 3;
  const MAX_REVERTS = 5;
  const confirmCounts = new Map<string, number>();
  const revertCounts = new Map<string, number>();
  // Track which devices need an injection (new command or reverted)
  const needsInject = new Set<string>();

  proxy.setResponseMutator((path: string, body: string) => {
    if (!path.includes('/machine/query/check/')) return null;

    // Find a device that needs injection
    let target: { deviceId: string; command: Record<string, string> } | null = null;
    for (const deviceId of needsInject) {
      const cmd = state.getPendingCommand(deviceId);
      if (cmd) {
        target = { deviceId, command: cmd };
        break;
      }
    }
    if (!target) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }

    if (parsed['code'] !== '2') return null;

    const data = parsed['data'] as Record<string, unknown> | undefined;
    const token = data?.['100'] ?? '';

    const injected = {
      code: '1',
      data: {
        '100': token,
        '2': '1',
        '3': target.command,
      },
    };

    // Mark as injected — don't inject again unless it reverts
    needsInject.delete(target.deviceId);

    // Also update upstream
    sendDeviceEditUpstream(target.deviceId, target.command);

    const json = JSON.stringify(injected);
    const cmdFlag22 = target.command['22'] ?? '0';
    const cmdTargetKey = getTargetKey(cmdFlag22);
    console.log(`[inject] ${target.deviceId}: key${cmdTargetKey}=${target.command[cmdTargetKey]} (${rawToCelsius(target.command[cmdTargetKey] ?? '')}°C) flag22=${cmdFlag22} (${flag22ToMode(cmdFlag22)}) confirms=${confirmCounts.get(target.deviceId) ?? 0}/${CONFIRM_THRESHOLD}`);
    return json;
  });

  // Wire up: proxy device edits -> state manager
  proxy.on('deviceEdit', ({ payload, timestamp }) => {
    const deviceId = payload['2'];
    if (!deviceId) return;

    const prev = state.getDevice(deviceId);
    const pending = state.isPending(deviceId);

    if (pending) {
      const cmd = state.getPendingCommand(deviceId);
      const wantFlag22 = cmd?.['22'];
      const incomingFlag22 = payload['22'];
      const flag22Match = wantFlag22 === undefined || incomingFlag22 === wantFlag22;

      // Check the target temperature field for the active mode
      const targetKey = getTargetKey(wantFlag22 ?? '0');
      const wantCelsius = rawToCelsius(cmd?.[targetKey] ?? '');
      const incomingCelsius = rawToCelsius(payload[targetKey] ?? '');
      const tempMatch = wantCelsius === incomingCelsius;

      if (tempMatch && flag22Match) {
        const count = (confirmCounts.get(deviceId) ?? 0) + 1;
        confirmCounts.set(deviceId, count);
        console.log(`[proxy] ${deviceId} confirm ${count}/${CONFIRM_THRESHOLD} (key${targetKey}=${incomingCelsius}°C flag22=${incomingFlag22})`);
        if (count >= CONFIRM_THRESHOLD) {
          console.log(`[proxy] ${deviceId} fully confirmed at key${targetKey}=${incomingCelsius}°C flag22=${incomingFlag22}`);
          state.clearPending(deviceId);
          confirmCounts.delete(deviceId);
          needsInject.delete(deviceId);
          revertCounts.delete(deviceId);
        }
      } else {
        // Reverted — re-inject and restart counter
        const reverts = (revertCounts.get(deviceId) ?? 0) + 1;
        revertCounts.set(deviceId, reverts);
        if (reverts >= MAX_REVERTS) {
          console.log(`[proxy] ${deviceId} giving up after ${reverts} reverts (want key${targetKey}=${wantCelsius}°C/flag22=${wantFlag22}, got=${incomingCelsius}°C/flag22=${incomingFlag22}) — device rejected command`);
          state.clearPending(deviceId);
          confirmCounts.delete(deviceId);
          needsInject.delete(deviceId);
          revertCounts.delete(deviceId);
          // Fall through to update state with what the device actually reports
        } else {
          console.log(`[proxy] ${deviceId} reverted ${reverts}/${MAX_REVERTS} (want key${targetKey}=${wantCelsius}°C/flag22=${wantFlag22}, got=${incomingCelsius}°C/flag22=${incomingFlag22}) — will re-inject`);
          confirmCounts.set(deviceId, 0);
          needsInject.add(deviceId);
          return; // don't update state with wrong value
        }
      }
    }

    state.updateFromDeviceEdit(payload);
    const deviceState = state.getDevice(deviceId);
    if (deviceState) {
      mqtt.publishDeviceState(deviceId, deviceState);
    }
  });

  // Initialize MQTT bridge
  const mqtt = new MqttBridge({ url: config.mqttUrl, prefix: config.mqttPrefix });

  // Send a device/edit payload to the upstream server so the cloud stays in sync.
  // Uses the device's stored payload_template (which contains the auth token) as a base.
  function sendDeviceEditUpstream(deviceId: string, overrides: Record<string, string>) {
    const device = state.getDevice(deviceId);
    if (!device?.payload_template) {
      console.log(`[upstream] no payload_template for ${deviceId}, skipping`);
      return;
    }

    const payload = { ...device.payload_template, ...overrides };
    const encoded = encodeURIComponent(JSON.stringify(payload));
    const path = `/api/v0.1/machine/device/edit/${encoded}`;

    const req = http.get({
      hostname: config.upstreamHost,
      port: config.upstreamHttpPort,
      path,
      headers: { Host: config.upstreamHostname },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        console.log(`[upstream] device/edit ${deviceId} -> ${res.statusCode} ${body.substring(0, 200)}`);
      });
    });

    req.on('error', (err) => {
      console.log(`[upstream] device/edit ${deviceId} error: ${err.message}`);
    });
  }

  // Helper: queue a pending temperature command (mode-aware)
  function queueTemperature(source: string, deviceId: string, celsius: number) {
    const device = state.getDevice(deviceId);
    if (!device) return;

    const mode = flag22ToMode(device.flag22);
    const targetKey = getTargetKey(device.flag22);
    console.log(`${source}: Set ${deviceId} temperature to ${celsius}°C (mode=${mode}, key=${targetKey})`);

    const raw = String(celsiusToRaw(celsius));
    const overrides: Record<string, string> = {
      '2': deviceId,
      '7': device.comfort,
      '11': device.manual,
      '14': '0',
      '22': device.flag22,
      '15': device.flag22,
    };
    // Set the target temperature for the active mode
    overrides[targetKey] = raw;
    if (targetKey === '7') overrides['11'] = raw; // keep manual in sync for comfort

    state.setPendingCommand(deviceId, overrides);
    needsInject.add(deviceId);
    confirmCounts.set(deviceId, 0);
    revertCounts.set(deviceId, 0);
    sendDeviceEditUpstream(deviceId, overrides);

    // Optimistic local state update — update the right field
    const FIELD_FOR_KEY: Record<string, keyof typeof device> = {
      '7': 'comfort', '8': 'frost', '9': 'eco', '10': 'boost',
    };
    const field = FIELD_FOR_KEY[targetKey] ?? 'comfort';
    (device as unknown as Record<string, string>)[field] = raw;
    if (targetKey === '7') device.manual = raw;
    device.last_update = new Date().toISOString();
    mqtt.publishDeviceState(deviceId, device);
  }

  // Helper: queue a pending mode command (sets flag22)
  function queueMode(source: string, deviceId: string, flag22: string) {
    console.log(`${source}: Set ${deviceId} mode flag22=${flag22} (${flag22ToMode(flag22)})`);
    const device = state.getDevice(deviceId);
    if (!device) return;
    const targetKey = getTargetKey(flag22);
    const FIELD_FOR_KEY: Record<string, keyof typeof device> = {
      '7': 'comfort', '8': 'frost', '9': 'eco', '10': 'boost',
    };
    const overrides: Record<string, string> = {
      '2': deviceId,
      '7': device.comfort,
      '11': device.manual,
      '14': '0',
      '22': flag22,
      '15': flag22,
    };
    // Include the target temp key so confirmation logic can match it
    const field = FIELD_FOR_KEY[targetKey];
    if (field && targetKey !== '7') overrides[targetKey] = String(device[field] ?? '');
    state.setPendingCommand(deviceId, overrides);
    needsInject.add(deviceId);
    confirmCounts.set(deviceId, 0);
    revertCounts.set(deviceId, 0);
    sendDeviceEditUpstream(deviceId, overrides);
    device.flag22 = flag22;
    device.last_update = new Date().toISOString();
    mqtt.publishDeviceState(deviceId, device);
  }

  // Wire up: MQTT commands
  mqtt.on('setTemperature', (deviceId: string, celsius: number) => {
    queueTemperature('MQTT', deviceId, celsius);
  });

  mqtt.on('setMode', (deviceId: string, flag22: string) => {
    queueMode('MQTT', deviceId, flag22);
  });

  // Initialize web server
  const web = new WebServer(config.webPort, state);

  // Wire up: Web UI commands
  web.on('setTemperature', (deviceId: string, celsius: number) => {
    queueTemperature('Web', deviceId, celsius);
  });

  web.on('setMode', (deviceId: string, flag22: string) => {
    queueMode('Web', deviceId, flag22);
  });

  // Start all services
  await proxy.start();
  await mqtt.start();
  await web.start();

  console.log(`HTTP proxy: 0.0.0.0:${config.httpPort} -> ${config.upstreamHost}:${config.upstreamHttpPort}`);
  console.log(`HTTPS proxy: 0.0.0.0:${config.httpsPort} -> ${config.upstreamHttpsHost}:${config.upstreamHttpsPort}`);
  console.log(`Web UI: http://0.0.0.0:${config.webPort}`);
  console.log(`MQTT: ${config.mqttUrl} (prefix: ${config.mqttPrefix})`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await web.stop();
    await mqtt.stop();
    await proxy.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
