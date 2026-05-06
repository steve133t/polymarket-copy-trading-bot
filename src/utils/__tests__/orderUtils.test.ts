import { extractOrderError, isInsufficientBalanceOrAllowanceError } from '../orderUtils';

describe('extractOrderError', () => {
    describe('null / undefined / empty inputs', () => {
        it('returns undefined for null', () => {
            expect(extractOrderError(null)).toBeUndefined();
        });

        it('returns undefined for undefined', () => {
            expect(extractOrderError(undefined)).toBeUndefined();
        });

        it('returns undefined for empty string', () => {
            // empty string is falsy — same branch as null/undefined
            expect(extractOrderError('')).toBeUndefined();
        });

        it('returns undefined for 0', () => {
            expect(extractOrderError(0)).toBeUndefined();
        });

        it('returns undefined for false', () => {
            expect(extractOrderError(false)).toBeUndefined();
        });
    });

    describe('string responses', () => {
        it('returns the string itself when given a non-empty string', () => {
            expect(extractOrderError('something went wrong')).toBe('something went wrong');
        });

        it('returns a whitespace-only string as-is', () => {
            expect(extractOrderError('   ')).toBe('   ');
        });
    });

    describe('object responses — .error field', () => {
        it('returns response.error when it is a string', () => {
            expect(extractOrderError({ error: 'order rejected' })).toBe('order rejected');
        });

        it('returns response.error.error when nested error is a string', () => {
            expect(extractOrderError({ error: { error: 'nested error' } })).toBe('nested error');
        });

        it('returns response.error.message when nested message is a string', () => {
            expect(extractOrderError({ error: { message: 'nested message' } })).toBe('nested message');
        });

        it('prefers response.error.error over response.error.message', () => {
            expect(
                extractOrderError({ error: { error: 'inner error', message: 'inner message' } })
            ).toBe('inner error');
        });
    });

    describe('object responses — .errorMsg field', () => {
        it('returns response.errorMsg when error field is absent', () => {
            expect(extractOrderError({ errorMsg: 'errorMsg field' })).toBe('errorMsg field');
        });

        it('returns response.errorMsg when error field is not a string or plain object', () => {
            // error is a number — not a string, not a plain object, so falls through
            expect(extractOrderError({ error: 42, errorMsg: 'fallback errorMsg' })).toBe(
                'fallback errorMsg'
            );
        });
    });

    describe('object responses — .message field (fallback)', () => {
        it('returns response.message as last-resort fallback', () => {
            expect(extractOrderError({ message: 'generic message' })).toBe('generic message');
        });

        it('returns response.message when neither error nor errorMsg is present', () => {
            expect(extractOrderError({ code: 500, message: 'server error' })).toBe('server error');
        });
    });

    describe('unexpected shapes', () => {
        it('returns undefined for a plain number', () => {
            expect(extractOrderError(42)).toBeUndefined();
        });

        it('returns undefined for an array', () => {
            expect(extractOrderError(['error1', 'error2'])).toBeUndefined();
        });

        it('returns undefined for an object with no known error keys', () => {
            expect(extractOrderError({ foo: 'bar', baz: 123 })).toBeUndefined();
        });

        it('returns undefined when error is null (nested check guarded)', () => {
            expect(extractOrderError({ error: null })).toBeUndefined();
        });
    });
});

describe('isInsufficientBalanceOrAllowanceError', () => {
    it('returns false for undefined', () => {
        expect(isInsufficientBalanceOrAllowanceError(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(isInsufficientBalanceOrAllowanceError('')).toBe(false);
    });

    it('returns true for messages containing "not enough balance" (lower-case)', () => {
        expect(isInsufficientBalanceOrAllowanceError('not enough balance to place order')).toBe(
            true
        );
    });

    it('returns true for messages containing "Not Enough Balance" (mixed case)', () => {
        expect(isInsufficientBalanceOrAllowanceError('Not Enough Balance')).toBe(true);
    });

    it('returns true for messages containing "NOT ENOUGH BALANCE" (upper-case)', () => {
        expect(isInsufficientBalanceOrAllowanceError('NOT ENOUGH BALANCE')).toBe(true);
    });

    it('returns true for messages containing "allowance" (lower-case)', () => {
        expect(isInsufficientBalanceOrAllowanceError('insufficient allowance')).toBe(true);
    });

    it('returns true for messages containing "ALLOWANCE" (upper-case)', () => {
        expect(isInsufficientBalanceOrAllowanceError('ALLOWANCE exceeded')).toBe(true);
    });

    it('returns false for unrelated error messages', () => {
        expect(isInsufficientBalanceOrAllowanceError('order size too small')).toBe(false);
    });

    it('returns false for completely unrelated text', () => {
        expect(isInsufficientBalanceOrAllowanceError('market closed')).toBe(false);
    });

    it('returns false for partial matches that are not the keywords', () => {
        expect(isInsufficientBalanceOrAllowanceError('enough said')).toBe(false);
    });
});
