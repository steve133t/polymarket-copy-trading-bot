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

/**
 * Detects the Polymarket signature type for a wallet address:
 *
 *   EOA              (0) — no contract code
 *   POLY_PROXY       (1) — Polymarket proxy wallet (UUPS / minimal-proxy, slot 0 empty)
 *   POLY_GNOSIS_SAFE (2) — standard Gnosis Safe (slot 0 holds masterCopy address)
 *
 * Polymarket proxy wallets are deployed by Polymarket's factory and use EIP-1967
 * (UUPS) or the minimal-proxy pattern. They are NOT standard Gnosis Safes.
 * Using the wrong signature type causes "maker address not allowed" errors.
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

        return isGnosisSafe ? SignatureTypeV2.POLY_GNOSIS_SAFE : SignatureTypeV2.POLY_PROXY;
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
