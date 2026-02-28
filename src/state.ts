/**
 * Device state manager for the Tempco/Purmo MITM proxy.
 *
 * Tracks device state from intercepted "device edit" payloads, persists
 * to disk as JSON, and provides helpers for building control payloads.
 */

import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { celsiusToRaw, rawToCelsius } from './temperature.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  payload_template?: Record<string, string>;
  last_update: string;
}

export interface ZoneAlias {
  zone_label: string;
  num_zone: string;
}

export interface ZoneAliases {
  [deviceId: string]: ZoneAlias;
}

// ---------------------------------------------------------------------------
// Payload field mapping: numbered key -> DeviceState field name
// ---------------------------------------------------------------------------

const FIELD_MAP: Record<string, keyof DeviceState> = {
  '3': 'reported_label',
  '4': 'mode_code',
  '6': 'schedule',
  '7': 'comfort',
  '8': 'frost',
  '9': 'eco',
  '10': 'boost',
  '11': 'manual',
  '12': 'min_set',
  '13': 'max_set',
  '14': 'time_boost',
  '16': 'temperature_air',
  '22': 'flag22',
  '23': 'power',
};

// ---------------------------------------------------------------------------
// StateManager
// ---------------------------------------------------------------------------

export interface StateManagerEvents {
  deviceUpdate: [deviceId: string, state: DeviceState];
}

export class StateManager extends EventEmitter {
  private readonly stateDir: string;
  private readonly devicesPath: string;
  private readonly aliasesPath: string;

  private devices: Record<string, DeviceState> = {};
  private aliases: ZoneAliases = {};
  private pendingCommands = new Map<string, Record<string, string>>();

  constructor(stateDir: string) {
    super();
    this.stateDir = stateDir;
    this.devicesPath = join(stateDir, 'devices.json');
    this.aliasesPath = join(stateDir, 'zone_aliases.json');
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /** Load state and aliases from disk. Missing files are silently ignored. */
  load(): void {
    // Ensure state directory exists
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }

    // Load devices
    if (existsSync(this.devicesPath)) {
      try {
        const raw = readFileSync(this.devicesPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.devices = parsed as Record<string, DeviceState>;
        }
      } catch {
        // Corrupted file -- start fresh
        this.devices = {};
      }
    }

    // Load zone aliases
    if (existsSync(this.aliasesPath)) {
      try {
        const raw = readFileSync(this.aliasesPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.aliases = parsed as ZoneAliases;
        }
      } catch {
        this.aliases = {};
      }
    }
  }

  /** Atomically persist current device state to disk. */
  save(): void {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }

    const tmpPath = this.devicesPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(this.devices, null, 2), 'utf-8');
    renameSync(tmpPath, this.devicesPath);
  }

  // -----------------------------------------------------------------------
  // Update from intercepted payload
  // -----------------------------------------------------------------------

  /**
   * Update device state from an intercepted "device edit" payload.
   *
   * The payload uses numbered string keys (see FIELD_MAP). Key "2" holds
   * the device ID; key "1" is an auth token and is ignored.
   *
   * @returns The device ID that was updated, or `null` if the payload
   *          was invalid (e.g. missing device ID).
   */
  updateFromDeviceEdit(payload: Record<string, string>): string | null {
    const deviceId = payload['2'];
    if (!deviceId) {
      return null;
    }

    // Get or initialise device state
    const existing: DeviceState = this.devices[deviceId] ?? this.emptyState();

    // Map numbered keys to named fields, merging non-null values
    for (const [key, field] of Object.entries(FIELD_MAP)) {
      const value = payload[key];
      if (value !== undefined && value !== null) {
        // All state values are stored as strings
        (existing as unknown as Record<string, unknown>)[field] = String(value);
      }
    }

    // Apply zone alias if one is configured
    const alias = this.aliases[deviceId];
    if (alias) {
      existing.zone_label = alias.zone_label;
      existing.num_zone = alias.num_zone;
    }

    // Derive the display label: prefer zone alias, fall back to reported
    existing.label = existing.zone_label || existing.reported_label;

    // Store the full payload as a template for future set-temperature calls
    existing.payload_template = { ...payload };

    existing.last_update = new Date().toISOString();

    this.devices[deviceId] = existing;
    this.save();

    console.log(`[state] update ${deviceId} comfort=${existing.comfort} (${rawToCelsius(existing.comfort)}°C) air=${existing.temperature_air} (${rawToCelsius(existing.temperature_air)}°C)`);

    this.emit('deviceUpdate', deviceId, existing);

    return deviceId;
  }

  // -----------------------------------------------------------------------
  // Getters
  // -----------------------------------------------------------------------

  getDevice(deviceId: string): DeviceState | undefined {
    return this.devices[deviceId];
  }

  getAllDevices(): Record<string, DeviceState> {
    return { ...this.devices };
  }

  /**
   * Queue a pending command for a device. The command payload matches the
   * format used in query/check code:"1" responses (keys 2, 7, 11, 14, 22, 15).
   */
  setPendingCommand(deviceId: string, command: Record<string, string>): void {
    this.pendingCommands.set(deviceId, command);
  }

  clearPending(deviceId: string): void {
    this.pendingCommands.delete(deviceId);
  }

  isPending(deviceId: string): boolean {
    return this.pendingCommands.has(deviceId);
  }

  getPendingCommand(deviceId: string): Record<string, string> | undefined {
    return this.pendingCommands.get(deviceId);
  }

  /**
   * Find a device by exact ID, label, zone_label, or prefix match.
   *
   * Search order:
   *  1. Exact device ID match
   *  2. Exact label / zone_label match (case-insensitive)
   *  3. Prefix match on device ID (case-insensitive)
   *  4. Substring match on label / zone_label (case-insensitive)
   */
  findDevice(query: string): { id: string; state: DeviceState } | undefined {
    if (!query) return undefined;

    // 1. Exact device ID
    if (this.devices[query]) {
      return { id: query, state: this.devices[query] };
    }

    const lowerQuery = query.toLowerCase();

    // 2. Exact label / zone_label match
    for (const [id, state] of Object.entries(this.devices)) {
      if (
        state.label.toLowerCase() === lowerQuery ||
        state.zone_label.toLowerCase() === lowerQuery ||
        state.reported_label.toLowerCase() === lowerQuery
      ) {
        return { id, state };
      }
    }

    // 3. Prefix match on device ID
    for (const [id, state] of Object.entries(this.devices)) {
      if (id.toLowerCase().startsWith(lowerQuery)) {
        return { id, state };
      }
    }

    // 4. Substring match on labels
    for (const [id, state] of Object.entries(this.devices)) {
      if (
        state.label.toLowerCase().includes(lowerQuery) ||
        state.zone_label.toLowerCase().includes(lowerQuery) ||
        state.reported_label.toLowerCase().includes(lowerQuery)
      ) {
        return { id, state };
      }
    }

    return undefined;
  }

  // -----------------------------------------------------------------------
  // Payload builders
  // -----------------------------------------------------------------------

  /**
   * Build a payload to set the manual/comfort temperature for a device.
   *
   * Uses the device's last captured `payload_template` as a base, updating
   * the comfort (key "7") and manual (key "11") temperature fields.
   *
   * @returns The payload record ready to send, or `null` if the device
   *          has no stored payload template.
   */
  buildSetTemperaturePayload(
    deviceId: string,
    celsius: number,
  ): Record<string, string> | null {
    const device = this.devices[deviceId];
    if (!device?.payload_template) {
      return null;
    }

    const raw = String(celsiusToRaw(celsius));
    const result = { ...device.payload_template };
    result['7'] = raw;   // comfort
    result['11'] = raw;  // manual
    return result;
  }

  /**
   * Build a payload to set or clear holiday mode for a device.
   *
   * @param on `true` to enable holiday mode, `false` to disable.
   * @returns The payload record ready to send, or `null` if the device
   *          has no stored payload template.
   */
  buildHolidayPayload(
    deviceId: string,
    on: boolean,
  ): Record<string, string> | null {
    const device = this.devices[deviceId];
    if (!device?.payload_template) {
      return null;
    }

    const result = { ...device.payload_template };
    result['22'] = on ? '2' : '0';
    return result;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private emptyState(): DeviceState {
    return {
      label: '',
      reported_label: '',
      zone_label: '',
      num_zone: '',
      mode_code: '',
      comfort: '',
      frost: '',
      eco: '',
      boost: '',
      manual: '',
      min_set: '',
      max_set: '',
      time_boost: '',
      flag22: '',
      power: '',
      temperature_air: '',
      schedule: '',
      last_update: '',
    };
  }
}
