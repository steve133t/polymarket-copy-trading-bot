import { ethers } from 'ethers';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { ClobClient, Chain, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import Logger from './logger';

const PROXY_WALLET = ENV.PROXY_WALLET as string;
const PRIVATE_KEY = ENV.PRIVATE_KEY as string;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL as string;
const RPC_URL = ENV.RPC_URL as string;

// Gnosis Safe stores its master copy (implementation) at storage slot 0.
// A non-zero value here means it is a Gnosis Safe.
const GNOSIS_SAFE_MASTER_COPY_SLOT = '0x0';

// EIP-1967 standard slot for the implementation address (UUPS / transparent proxies).
// Polymarket V2 proxy wallets use this pattern → signatureType POLY_1271 (3).
// Polymarket V1 proxy wallets use the minimal-proxy pattern (no EIP-1967 slot) → POLY_PROXY (1).
const EIP1967_IMPLEMENTATION_SLOT =
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/**
 * Detects the Polymarket signature type for a wallet address:
 *
 *   EOA              (0) — no contract code
 *   POLY_PROXY       (1) — Polymarket V1 proxy wallet (minimal-proxy, no EIP-1967 slot)
 *   POLY_GNOSIS_SAFE (2) — standard Gnosis Safe (slot 0 holds masterCopy address)
 *   POLY_1271        (3) — Polymarket V2 proxy wallet (EIP-1967 UUPS, implements EIP-1271)
 *
 * Polymarket V2 proxy wallets are deployed using an EIP-1967 UUPS pattern and
 * implement EIP-1271 (`isValidSignature`). Orders must use signatureType POLY_1271 (3)
 * with signer = maker = proxy wallet address. Using POLY_PROXY (1) causes
 * "maker address not allowed" errors from the CLOB backend.
 */
const detectSignatureType = async (address: string): Promise<SignatureTypeV2> => {
    try {
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const code = await provider.getCode(address);

        if (code === '0x') {
            return SignatureTypeV2.EOA;
        }

        // Gnosis Safe stores the masterCopy address in slot 0 (non-zero for a Safe).
        const slot0 = await provider.getStorageAt(address, GNOSIS_SAFE_MASTER_COPY_SLOT);
        const masterCopy = '0x' + slot0.slice(-40); // last 20 bytes
        const isGnosisSafe = masterCopy !== '0x' + '0'.repeat(40);

        if (isGnosisSafe) {
            return SignatureTypeV2.POLY_GNOSIS_SAFE;
        }

        // Polymarket V2 proxy wallets use EIP-1967 UUPS: their implementation address
        // is stored in the standard EIP-1967 slot (non-zero). These wallets implement
        // EIP-1271 and must use signatureType POLY_1271 (3).
        // Polymarket V1 proxy wallets use the minimal-proxy pattern and have no
        // EIP-1967 slot, so they fall through to POLY_PROXY (1).
        const implSlot = await provider.getStorageAt(address, EIP1967_IMPLEMENTATION_SLOT);
        const implAddress = '0x' + implSlot.slice(-40);
        const hasEip1967Impl = implAddress !== '0x' + '0'.repeat(40);

        return hasEip1967Impl ? SignatureTypeV2.POLY_1271 : SignatureTypeV2.POLY_PROXY;
    } catch (error) {
        Logger.error(`Error detecting wallet type: ${error}`);
        return SignatureTypeV2.EOA;
    }
};

const createClobClient = async (): Promise<ClobClient> => {
    // Ensure private key has 0x prefix (required by viem)
    const privateKey = (PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`) as `0x${string}`;

    const account = privateKeyToAccount(privateKey);
    const walletClient = createWalletClient({
        account,
        chain: polygon,
        transport: http(RPC_URL),
    });

    const signatureType = await detectSignatureType(PROXY_WALLET);
    const isContract = signatureType !== SignatureTypeV2.EOA;

    const typeLabel: Record<SignatureTypeV2, string> = {
        [SignatureTypeV2.EOA]: 'EOA',
        [SignatureTypeV2.POLY_PROXY]: 'Polymarket Proxy (POLY_PROXY)',
        [SignatureTypeV2.POLY_GNOSIS_SAFE]: 'Gnosis Safe (POLY_GNOSIS_SAFE)',
        [SignatureTypeV2.POLY_1271]: 'EIP-1271 (POLY_1271)',
    };
    Logger.info(`Wallet type detected: ${typeLabel[signatureType]}`);

    // Build the unauthenticated client used only to obtain API credentials
    const unauthClient = new ClobClient({
        host: CLOB_HTTP_URL,
        chain: Chain.POLYGON,
        signer: walletClient,
        signatureType,
        funderAddress: isContract ? PROXY_WALLET : undefined,
    });

    // createOrDeriveApiKey tries createApiKey first, falls back to deriveApiKey
    const originalLog = console.log;
    const originalErr = console.error;
    console.log = () => {};
    console.error = () => {};
    let creds;
    try {
        creds = await unauthClient.createOrDeriveApiKey();
    } finally {
        console.log = originalLog;
        console.error = originalErr;
    }
    if (!creds?.key) throw new Error('Failed to obtain Polymarket API credentials');

    return new ClobClient({
        host: CLOB_HTTP_URL,
        chain: Chain.POLYGON,
        signer: walletClient,
        creds,
        signatureType,
        funderAddress: isContract ? PROXY_WALLET : undefined,
    });
};

export default createClobClient;
