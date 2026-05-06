import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const ROOT_DIR = path.join(process.cwd(), '..');
const REPORTS_DIR = path.join(ROOT_DIR, 'trader_reports');
const ENV_PATH = path.join(ROOT_DIR, '.env');
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();
    const commentIndex = value.indexOf(' #');
    if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();

    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function currentEnvForAnalyzer() {
  if (!fs.existsSync(ENV_PATH)) return process.env;
  return {
    ...process.env,
    ...parseEnvFile(fs.readFileSync(ENV_PATH, 'utf-8')),
  };
}

async function refreshTraderReports() {
  const env = currentEnvForAnalyzer();
  const options = {
    cwd: ROOT_DIR,
    env,
    timeout: 5 * 60_000,
    maxBuffer: 10 * 1024 * 1024,
  };

  if (process.platform === 'win32') {
    await execAsync('npm run analyze', options);
    return;
  }

  await execFileAsync('npm', ['run', 'analyze'], options);
}

export interface MonthlyStats {
  month: string;
  totalBought: number;
  totalSold: number;
  netFlow: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
}

export interface TraderAnalysis {
  address: string;
  label: string;
  analysisDate: string;
  periodMonths: number;
  trades: {
    total: number;
    buys: number;
    sells: number;
    firstTrade: string;
    lastTrade: string;
    daysActive: number;
  };
  volume: {
    totalBought: number;
    totalSold: number;
    netFlow: number;
  };
  positions: {
    total: number;
    open: number;
    winners: number;
    losers: number;
    winRate: number;
    initialValue: number;
    currentValue: number;
  };
  pnl: {
    unrealized: number;
    realized: number;
    total: number;
    roi: number;
    monthlyRoi: number;
    annualizedRoi: number;
  };
  redeemable: {
    count: number;
    value: number;
  };
  monthlyBreakdown: MonthlyStats[];
  topWinners: { title: string; outcome: string; pnl: number; roi: number }[];
  topLosers: { title: string; outcome: string; pnl: number; roi: number }[];
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const shouldRefresh = searchParams.get('refresh') === 'true';

    if (shouldRefresh) {
      await refreshTraderReports();
    }

    if (!fs.existsSync(REPORTS_DIR)) {
      return NextResponse.json(
        { error: 'trader_reports directory not found. Run the analyzeAllTraders script first.' },
        { status: 404 }
      );
    }

    // Try to read summary file first
    const summaryPath = path.join(REPORTS_DIR, '_SUMMARY.json');

    if (fs.existsSync(summaryPath)) {
      const summaryData = fs.readFileSync(summaryPath, 'utf-8');
      const traders: TraderAnalysis[] = JSON.parse(summaryData);
      return NextResponse.json({ traders, refreshed: shouldRefresh }, { headers: NO_STORE_HEADERS });
    }

    // Fallback: read individual JSON files
    const files = fs.readdirSync(REPORTS_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json') && !f.startsWith('_'));

    const traders: TraderAnalysis[] = [];

    for (const file of jsonFiles) {
      const filePath = path.join(REPORTS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const trader = JSON.parse(content);
      traders.push(trader);
    }

    return NextResponse.json({ traders, refreshed: shouldRefresh }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('Error reading trader reports:', error);
    return NextResponse.json(
      { error: `Failed to read trader reports: ${error instanceof Error ? error.message : error}` },
      { status: 500 }
    );
  }
}
