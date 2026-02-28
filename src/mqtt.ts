/**
 * MQTT bridge for the Tempco/Purmo heating system.
 *
 * Publishes device state to MQTT topics and subscribes to command topics
 * for remote temperature and holiday control.
 */

import { EventEmitter } from 'node:events';
import mqtt, { type MqttClient } from 'mqtt';
import { rawToCelsius, celsiusToRaw } from './temperature.js';
import { flag22ToMode, modeToFlag22 } from './modes.js';

export interface MqttBridgeConfig {
  url: string;
  prefix: string;
}

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

export interface MqttBridgeEvents {
  setTemperature: [deviceId: string, celsius: number];
  setMode: [deviceId: string, flag22: string];
  connected: [];
  disconnected: [];
  error: [error: Error];
}

export class MqttBridge extends EventEmitter {
  private readonly config: MqttBridgeConfig;
  private client: MqttClient | null = null;
  private connected = false;

  constructor(config: MqttBridgeConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const { url, prefix } = this.config;

      this.client = mqtt.connect(url, {
        clientId: `tempco-bridge-${process.pid}`,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
        will: {
          topic: `${prefix}/bridge/status`,
          payload: Buffer.from('offline'),
          qos: 1,
          retain: true,
        },
      });

      this.client.on('connect', () => {
        this.connected = true;
        console.log(`[mqtt] connected to ${url}`);

        // Publish online status
        this.client!.publish(
          `${prefix}/bridge/status`,
          'online',
          { qos: 1, retain: true },
        );

        // Subscribe to command topics using wildcards
        const commandTopics = [
          `${prefix}/zones/+/target/set`,
          `${prefix}/zones/+/mode/set`,
        ];

        this.client!.subscribe(commandTopics, { qos: 1 }, (err) => {
          if (err) {
            console.error('[mqtt] subscription error:', err.message);
          } else {
            console.log('[mqtt] subscribed to command topics');
          }
        });

        this.emit('connected');
        resolve();
      });

      this.client.on('message', (topic: string, payload: Buffer) => {
        this.handleMessage(topic, payload.toString());
      });

      this.client.on('error', (err: Error) => {
        console.error('[mqtt] error:', err.message);
        this.emit('error', err);
        // Only reject on initial connect; after that errors are emitted
        if (!this.connected) {
          reject(err);
        }
      });

      this.client.on('offline', () => {
        if (this.connected) {
          this.connected = false;
          console.log('[mqtt] disconnected');
          this.emit('disconnected');
        }
      });

      this.client.on('reconnect', () => {
        console.log('[mqtt] reconnecting...');
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.client) return;

    const { prefix } = this.config;

    return new Promise<void>((resolve) => {
      // Publish offline status before disconnecting
      this.client!.publish(
        `${prefix}/bridge/status`,
        'offline',
        { qos: 1, retain: true },
        () => {
          this.client!.end(false, {}, () => {
            this.connected = false;
            this.client = null;
            console.log('[mqtt] stopped');
            resolve();
          });
        },
      );
    });
  }

  /**
   * Publish the full device state to MQTT topics.
   *
   * Publishes both a JSON blob with all fields (including celsius conversions)
   * and individual convenience topics for temperature, target, power, and holiday.
   */
  publishDeviceState(deviceId: string, state: DeviceState): void {
    if (!this.client || !this.connected) return;

    const { prefix } = this.config;
    const base = `${prefix}/zones/${deviceId}`;

    // Convert raw temperature values to celsius
    const temperatureAirCelsius = rawToCelsius(state.temperature_air);
    const comfortCelsius = rawToCelsius(state.comfort);
    const frostCelsius = rawToCelsius(state.frost);
    const ecoCelsius = rawToCelsius(state.eco);
    const boostCelsius = rawToCelsius(state.boost);
    const manualCelsius = rawToCelsius(state.manual);
    const minSetCelsius = rawToCelsius(state.min_set);
    const maxSetCelsius = rawToCelsius(state.max_set);

    const power = parseInt(state.power, 10) || 0;
    const modeName = flag22ToMode(state.flag22);

    // Full state JSON with celsius conversions
    const statePayload = JSON.stringify({
      ...state,
      temperature_air_celsius: temperatureAirCelsius,
      comfort_celsius: comfortCelsius,
      frost_celsius: frostCelsius,
      eco_celsius: ecoCelsius,
      boost_celsius: boostCelsius,
      manual_celsius: manualCelsius,
      min_set_celsius: minSetCelsius,
      max_set_celsius: maxSetCelsius,
      power_watts: power,
      mode: modeName,
    });

    // Publish full state
    this.client.publish(`${base}/state`, statePayload, {
      qos: 0,
      retain: true,
    });

    // Publish individual convenience topics
    this.client.publish(`${base}/temperature`, String(temperatureAirCelsius), {
      qos: 0,
      retain: true,
    });

    this.client.publish(`${base}/target`, String(comfortCelsius), {
      qos: 0,
      retain: true,
    });

    this.client.publish(`${base}/power`, String(power), {
      qos: 0,
      retain: true,
    });

    this.client.publish(`${base}/mode`, modeName, {
      qos: 0,
      retain: true,
    });
  }

  /**
   * Handle an incoming MQTT message on a subscribed command topic.
   */
  private handleMessage(topic: string, payload: string): void {
    const { prefix } = this.config;

    // Match: {prefix}/zones/{deviceId}/target/set
    const targetMatch = topic.match(
      new RegExp(`^${escapeRegex(prefix)}/zones/([^/]+)/target/set$`),
    );
    if (targetMatch) {
      const deviceId = targetMatch[1]!;
      const celsius = parseFloat(payload.trim());
      if (!Number.isFinite(celsius)) {
        console.warn(`[mqtt] invalid temperature value: ${payload}`);
        return;
      }
      console.log(`[mqtt] command: set temperature ${deviceId} -> ${celsius}C`);
      this.emit('setTemperature', deviceId, celsius);
      return;
    }

    // Match: {prefix}/zones/{deviceId}/mode/set
    const modeMatch = topic.match(
      new RegExp(`^${escapeRegex(prefix)}/zones/([^/]+)/mode/set$`),
    );
    if (modeMatch) {
      const deviceId = modeMatch[1]!;
      const value = payload.trim();
      // Accept mode names ("comfort", "antifreeze") or raw flag22 values ("3")
      const flag22 = modeToFlag22(value) ?? value;
      console.log(`[mqtt] command: set mode ${deviceId} -> ${value} (flag22=${flag22})`);
      this.emit('setMode', deviceId, flag22);
      return;
    }
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
