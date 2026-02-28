/**
 * Temperature conversion utilities for Tempco/Purmo heating system.
 *
 * The system encodes temperatures as integer "raw" values:
 *   raw = Math.round(celsius * 18 + 320)
 *   celsius = (raw - 320) / 18
 */

/**
 * Convert a raw encoded temperature value to degrees Celsius.
 * Accepts either a number or a numeric string.
 * Returns the result rounded to 1 decimal place.
 */
export function rawToCelsius(raw: number | string): number {
  const numRaw = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (!Number.isFinite(numRaw)) {
    return NaN;
  }
  const celsius = (numRaw - 320) / 18;
  return Math.round(celsius * 2) / 2;
}

/**
 * Convert a Celsius temperature to the raw encoded integer value.
 * Returns the nearest integer raw value.
 */
export function celsiusToRaw(celsius: number): number {
  if (!Number.isFinite(celsius)) {
    return NaN;
  }
  return Math.round(celsius * 18 + 320);
}
