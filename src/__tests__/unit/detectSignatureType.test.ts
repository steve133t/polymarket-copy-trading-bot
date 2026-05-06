/**
 * Unit tests: detectSignatureType()
 *
 * Tests the wallet-type detection logic that determines whether a proxy wallet
 * is an EOA, Gnosis Safe, Polymarket V1 POLY_PROXY, or Polymarket V2 POLY_1271.
 *
 * All tests mock the ethers JsonRpcProvider — no live RPC calls are made.
 *
 * Run: npm test -- --testPathPattern=detectSignatureType
 */

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
    },
}));

// Mock ethers BEFORE the module under test is imported so jest.mock() hoisting works.
jest.mock('ethers', () => {
    const actual = jest.requireActual('ethers');
    return {
        ...actual,
        ethers: {
            ...actual.ethers,
            providers: {
                JsonRpcProvider: jest.fn(),
            },
        },
    };
});

import { ethers } from 'ethers';
import { SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { detectSignatureType } from '../../utils/createClobClient';

const ZERO_SLOT = '0x' + '0'.repeat(64);
const NONZERO_SLOT = (addr: string) => '0x000000000000000000000000' + addr.slice(2).toLowerCase();

// Known addresses (content doesn't matter for detection; we just need known strings)
const EOA_ADDR = '0x1111111111111111111111111111111111111111';
const GNOSIS_ADDR = '0x2222222222222222222222222222222222222222';
const V1_PROXY_ADDR = '0x3333333333333333333333333333333333333333';
const V2_PROXY_ADDR = '0x4444444444444444444444444444444444444444';
const IMPL_ADDR = '0x58ca52ebe0dadfdf531cde7062e76746de4db1eb';

// EIP-1967 implementation slot constant (must match createClobClient.ts)
const EIP1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const GNOSIS_SLOT = '0x0';

function makeMockProvider({
    code = '0x',
    slot0 = ZERO_SLOT,
    eip1967Slot = ZERO_SLOT,
}: {
    code?: string;
    slot0?: string;
    eip1967Slot?: string;
}) {
    const getCode = jest.fn().mockResolvedValue(code);
    const getStorageAt = jest.fn().mockImplementation((_addr: string, slot: string) => {
        if (slot === GNOSIS_SLOT) return Promise.resolve(slot0);
        if (slot === EIP1967_SLOT) return Promise.resolve(eip1967Slot);
        return Promise.resolve(ZERO_SLOT);
    });
    (ethers.providers.JsonRpcProvider as unknown as jest.Mock).mockImplementation(() => ({
        getCode,
        getStorageAt,
    }));
    return { getCode, getStorageAt };
}

afterEach(() => jest.clearAllMocks());

describe('detectSignatureType', () => {
    it('returns EOA (0) for an address with no contract code', async () => {
        makeMockProvider({ code: '0x' });
        const result = await detectSignatureType(EOA_ADDR, 'http://fake-rpc');
        expect(result).toBe(SignatureTypeV2.EOA);
    });

    it('returns POLY_GNOSIS_SAFE (2) when storage slot 0 holds a non-zero masterCopy', async () => {
        makeMockProvider({
            code: '0xdeadbeef', // some bytecode → it's a contract
            slot0: NONZERO_SLOT(GNOSIS_ADDR),
        });
        const result = await detectSignatureType(GNOSIS_ADDR, 'http://fake-rpc');
        expect(result).toBe(SignatureTypeV2.POLY_GNOSIS_SAFE);
    });

    it('returns POLY_PROXY (1) for a V1 minimal-proxy (no EIP-1967 slot, slot 0 = 0)', async () => {
        makeMockProvider({
            code: '0xdeadbeef',
            slot0: ZERO_SLOT,
            eip1967Slot: ZERO_SLOT,
        });
        const result = await detectSignatureType(V1_PROXY_ADDR, 'http://fake-rpc');
        expect(result).toBe(SignatureTypeV2.POLY_PROXY);
    });

    it('returns POLY_1271 (3) for a V2 EIP-1967 UUPS proxy (slot 0 = 0, EIP-1967 slot ≠ 0)', async () => {
        makeMockProvider({
            code: '0xdeadbeef',
            slot0: ZERO_SLOT,
            eip1967Slot: NONZERO_SLOT(IMPL_ADDR),
        });
        const result = await detectSignatureType(V2_PROXY_ADDR, 'http://fake-rpc');
        expect(result).toBe(SignatureTypeV2.POLY_1271);
    });

    it('throws on RPC error so callers get a clear failure rather than a silent EOA fallback', async () => {
        (ethers.providers.JsonRpcProvider as unknown as jest.Mock).mockImplementation(() => ({
            getCode: jest.fn().mockRejectedValue(new Error('network timeout')),
            getStorageAt: jest.fn(),
        }));
        await expect(detectSignatureType(V2_PROXY_ADDR, 'http://fake-rpc')).rejects.toThrow(
            'network timeout'
        );
    });

    it('is not confused by a Gnosis Safe that also has an EIP-1967 slot set', async () => {
        // Gnosis Safe takes precedence: slot 0 check comes before EIP-1967 check.
        makeMockProvider({
            code: '0xdeadbeef',
            slot0: NONZERO_SLOT(GNOSIS_ADDR),
            eip1967Slot: NONZERO_SLOT(IMPL_ADDR), // also set — should be ignored
        });
        const result = await detectSignatureType(GNOSIS_ADDR, 'http://fake-rpc');
        expect(result).toBe(SignatureTypeV2.POLY_GNOSIS_SAFE);
    });
});
