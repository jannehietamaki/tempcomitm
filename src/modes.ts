/**
 * Device mode constants for Tempco/Purmo heating system.
 *
 * Single source of truth for mode name <-> flag22 mapping.
 * Values marked "guess" need verification via experimentation.
 */

export interface ModeInfo {
  flag22: string;
  label: string;
}

// Easy to update after testing — just change the flag22 values here.
export const MODES: Record<string, ModeInfo> = {
  comfort:    { flag22: '0',  label: 'Comfort' },        // confirmed
  off:        { flag22: '1',  label: 'Off' },             // confirmed
  antifreeze: { flag22: '2',  label: 'Anti Freeze' },    // confirmed
  eco:        { flag22: '3',  label: 'Eco' },             // confirmed
  boost:      { flag22: '4',  label: 'Boost' },           // confirmed
  program:    { flag22: '11', label: 'Program' },         // confirmed
};

// Reverse map: flag22 value -> mode name
const FLAG22_TO_MODE: Record<string, string> = {};
for (const [name, info] of Object.entries(MODES)) {
  FLAG22_TO_MODE[info.flag22] = name;
}

/** Get mode name from a flag22 value. Returns "unknown(N)" for unmapped values. */
export function flag22ToMode(flag22: string): string {
  return FLAG22_TO_MODE[flag22] ?? `unknown(${flag22})`;
}

/** Get flag22 value from a mode name. Returns undefined if mode name is unknown. */
export function modeToFlag22(modeName: string): string | undefined {
  return MODES[modeName.toLowerCase()]?.flag22;
}

/**
 * Get the payload key for the target temperature used by a given mode.
 * Each mode uses a different temperature register:
 *   comfort/program → key 7 (comfort), antifreeze → key 8 (frost),
 *   eco → key 9, boost → key 10.
 */
export function getTargetKey(flag22: string): string {
  switch (flag22) {
    case '2': return '8';   // antifreeze → frost
    case '3': return '9';   // eco
    case '4': return '10';  // boost
    default:  return '7';   // comfort, off, program
  }
}

/**
 * Get the DeviceState field name for the target temperature used by a given mode.
 */
export function getTargetField(flag22: string): string {
  switch (flag22) {
    case '2': return 'frost';
    case '3': return 'eco';
    case '4': return 'boost';
    default:  return 'comfort';
  }
}
