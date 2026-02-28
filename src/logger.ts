/**
 * Transaction logger that writes each HTTP transaction to a JSON file.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Transaction } from './proxy.js';

export class TransactionLogger {
  private readonly logDir: string;
  private readonly disabled: boolean;

  constructor(logDir: string, disabled: boolean) {
    this.logDir = logDir;
    this.disabled = disabled;

    if (!disabled) {
      try {
        mkdirSync(logDir, { recursive: true });
      } catch {
        // directory may already exist
      }
    }
  }

  /**
   * Log a transaction to a JSON file.  No-op if logging is disabled.
   */
  log(transaction: Transaction): void {
    if (this.disabled) return;

    const entry = {
      timestamp: transaction.timestamp,
      client: transaction.clientAddress,
      method: transaction.request.method,
      path: transaction.request.path,
      version: transaction.request.version,
      requestHeaders: transaction.request.headers,
      requestBody: transaction.request.body,
      response: {
        timestamp: new Date().toISOString(),
        version: transaction.response.version,
        status: transaction.response.status,
        reason: transaction.response.reason,
        headers: transaction.response.headers,
        body: transaction.response.body,
      },
    };

    const filename = buildFilename(transaction.request.path);
    const filePath = join(this.logDir, filename);

    try {
      writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[tempco-logger] Failed to write ${filePath}: ${err}`);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

const MAX_SLUG_LENGTH = 60;

/**
 * Build a log filename from a request path.
 *
 * Format: `{ISO_timestamp}_{path_slug}.json`
 *
 * The path slug is sanitised to be filesystem-safe and capped at 60
 * characters.  If truncation occurs, a sha1 fragment is appended so
 * that distinct long paths produce distinct filenames.
 */
function buildFilename(path: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '')        // 20260228T143059123Z
    .replace('T', 'T');

  let slug = (path.replace(/^\/+/, '').replace(/\/+/g, '_')) || 'root';
  // Strip characters that are unfriendly on most filesystems
  slug = slug.replace(/[^a-zA-Z0-9_\-]/g, '_');

  if (slug.length > MAX_SLUG_LENGTH) {
    const digest = createHash('sha1').update(path).digest('hex').substring(0, 10);
    slug = `${slug.substring(0, 40)}_${digest}`;
  }

  return `${stamp}_${slug}.json`;
}
