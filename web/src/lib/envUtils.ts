import * as fs from 'fs';
import * as path from 'path';

export const ENV_PATH = path.join(process.cwd(), '..', '.env');

/**
 * Parse a single value from a .env file string by key.
 * Handles: spaces around =, single/double quotes, inline comments.
 */
export function parseEnvValue(content: string, key: string): string {
  const line = content
    .split('\n')
    .find(
      envLine =>
        envLine.trim().startsWith(`${key} =`) ||
        envLine.trim().startsWith(`${key}=`)
    );
  if (!line) return '';

  const equalIndex = line.indexOf('=');
  let value = line.slice(equalIndex + 1).trim();

  // Strip inline comments
  const commentIndex = value.indexOf(' #');
  if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();

  // Strip surrounding quotes
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }

  return value;
}

/**
 * Read a single key from the bot's root .env file.
 * Returns undefined if the file doesn't exist or the key isn't found.
 */
export function readEnvKey(key: string): string | undefined {
  try {
    if (!fs.existsSync(ENV_PATH)) return undefined;
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    const value = parseEnvValue(content, key);
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse all key-value pairs from a .env file string.
 * Handles: spaces around =, single/double quotes, inline comments.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();

    // Strip inline comments
    const commentIndex = value.indexOf(' #');
    if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }
  return result;
}
