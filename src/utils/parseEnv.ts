/**
 * Parse a single value from .env file content by key.
 * Handles: spaces around =, single/double quotes, inline comments.
 */
export function parseEnvValue(content: string, key: string): string {
    const line = content
        .split('\n')
        .find(
            (envLine) =>
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
