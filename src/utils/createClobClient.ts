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

/**
 * Determines if a wallet is a Gnosis Safe by checking if it has contract code.
 * If PROXY_WALLET is a deployed contract it is treated as POLY_GNOSIS_SAFE (type 2).
 */
const isGnosisSafe = async (address: string): Promise<boolean> => {
    try {
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const code = await provider.getCode(address);
        return code !== '0x';
    } catch (error) {
        Logger.error(`Error checking wallet type: ${error}`);
        return false;
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

    // Detect if the proxy wallet is a Gnosis Safe or plain EOA
    const isProxySafe = await isGnosisSafe(PROXY_WALLET);
    const signatureType = isProxySafe
        ? SignatureTypeV2.POLY_GNOSIS_SAFE
        : SignatureTypeV2.EOA;

    Logger.info(
        `Wallet type detected: ${isProxySafe ? 'Gnosis Safe (POLY_GNOSIS_SAFE)' : 'EOA'}`
    );

    // Build the unauthenticated client used only to obtain API credentials
    const unauthClient = new ClobClient({
        host: CLOB_HTTP_URL,
        chain: Chain.POLYGON,
        signer: walletClient,
        signatureType,
        funderAddress: isProxySafe ? PROXY_WALLET : undefined,
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
        funderAddress: isProxySafe ? PROXY_WALLET : undefined,
    });
};

export default createClobClient;
