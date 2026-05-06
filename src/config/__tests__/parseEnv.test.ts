import { parseEnvValue } from '../../../src/utils/parseEnv';

describe('parseEnvValue', () => {
    it('parses a plain value', () => {
        expect(parseEnvValue('FOO = bar', 'FOO')).toBe('bar');
    });

    it('parses a value with no spaces around =', () => {
        expect(parseEnvValue('FOO=bar', 'FOO')).toBe('bar');
    });

    it('strips single quotes', () => {
        expect(parseEnvValue("FOO = 'FIXED'", 'FOO')).toBe('FIXED');
    });

    it('strips double quotes', () => {
        expect(parseEnvValue('FOO = "FIXED"', 'FOO')).toBe('FIXED');
    });

    it('strips inline comments', () => {
        expect(parseEnvValue('FOO = bar # this is a comment', 'FOO')).toBe('bar');
    });

    it('returns empty string when key not found', () => {
        expect(parseEnvValue('OTHER = value', 'FOO')).toBe('');
    });

    it('does not match a key that is a prefix of another', () => {
        // FOO_BAR should not match when searching for FOO
        expect(parseEnvValue('FOO_BAR = value', 'FOO')).toBe('');
    });

    it('handles multiline env content', () => {
        const content = ['KEY1 = val1', 'KEY2 = val2', 'KEY3 = val3'].join('\n');
        expect(parseEnvValue(content, 'KEY2')).toBe('val2');
    });

    it('strips quotes then inline comment', () => {
        expect(parseEnvValue("FOO = 'hello' # world", 'FOO')).toBe('hello');
    });
});
