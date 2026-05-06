import { NextResponse } from 'next/server';
import { HealthCheckResult } from '@/types/settings';
import { readEnvKey } from '@/lib/envUtils';

const getEnvValue = readEnvKey;

export async function GET() {
  const result: HealthCheckResult = {
    healthy: true,
    checks: {
      database: { status: 'ok' },
      rpc: { status: 'ok' },
      balance: { status: 'ok' },
      api: { status: 'ok' },
    },
    timestamp: new Date().toISOString(),
  };

  // Check MongoDB connection
  try {
    const mongoUri = getEnvValue('MONGO_URI');
    if (!mongoUri) {
      result.checks.database = { status: 'error', message: 'MONGO_URI not configured' };
      result.healthy = false;
    } else {
      // Simple check - just verify URI format
      if (!mongoUri.startsWith('mongodb')) {
        result.checks.database = { status: 'error', message: 'Invalid MongoDB URI format' };
        result.healthy = false;
      }
    }
  } catch (error) {
    result.checks.database = { status: 'error', message: String(error) };
    result.healthy = false;
  }

  // Check RPC endpoint
  try {
    const rpcUrl = getEnvValue('RPC_URL');
    if (!rpcUrl) {
      result.checks.rpc = { status: 'error', message: 'RPC_URL not configured' };
      result.healthy = false;
    } else {
      // Try to call eth_blockNumber
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1,
        }),
      });

      if (!response.ok) {
        result.checks.rpc = { status: 'error', message: `RPC returned ${response.status}` };
        result.healthy = false;
      } else {
        const data = await response.json();
        if (data.error) {
          result.checks.rpc = { status: 'error', message: data.error.message };
          result.healthy = false;
        }
      }
    }
  } catch (error) {
    result.checks.rpc = { status: 'error', message: `RPC connection failed: ${error}` };
    result.healthy = false;
  }

  // Check Polymarket API
  try {
    const clobUrl = getEnvValue('CLOB_HTTP_URL') || 'https://clob.polymarket.com/';
    const response = await fetch(`${clobUrl}time`, {
      method: 'GET',
    });

    if (!response.ok) {
      result.checks.api = { status: 'error', message: `Polymarket API returned ${response.status}` };
      result.healthy = false;
    }
  } catch (error) {
    result.checks.api = { status: 'error', message: `Polymarket API connection failed: ${error}` };
    result.healthy = false;
  }

  // Check USDC balance via RPC
  try {
    const rpcUrl = getEnvValue('RPC_URL');
    const proxyWallet = getEnvValue('PROXY_WALLET');
    const usdcContract = getEnvValue('USDC_CONTRACT_ADDRESS') || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

    if (rpcUrl && proxyWallet) {
      // ERC20 balanceOf call
      const data = `0x70a08231000000000000000000000000${proxyWallet.slice(2).toLowerCase()}`;

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to: usdcContract, data }, 'latest'],
          id: 1,
        }),
      });

      if (response.ok) {
        const json = await response.json();
        if (json.result) {
          // USDC has 6 decimals
          const balanceWei = BigInt(json.result);
          const balance = Number(balanceWei) / 1e6;

          result.checks.balance = {
            status: balance < 10 ? 'warning' : 'ok',
            value: balance,
            message: balance < 10 ? `Low balance: $${balance.toFixed(2)}` : undefined,
          };

          if (balance < 1) {
            result.checks.balance.status = 'error';
            result.checks.balance.message = `Very low balance: $${balance.toFixed(2)}`;
            result.healthy = false;
          }
        }
      }
    } else {
      result.checks.balance = { status: 'warning', message: 'Wallet not configured' };
    }
  } catch (error) {
    result.checks.balance = { status: 'error', message: `Failed to check balance: ${error}` };
  }

  return NextResponse.json(result);
}
