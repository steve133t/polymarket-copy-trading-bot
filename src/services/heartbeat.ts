import { ENV } from '../config/env';
import Logger from '../utils/logger';
import connectDB from '../config/db';
import mongoose from 'mongoose';

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const HEARTBEAT_COLLECTION = 'bot_heartbeat';
const HEARTBEAT_DOC_ID = 'main';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

async function writeHeartbeat(): Promise<void> {
    try {
        const db = mongoose.connection.db;
        if (!db) return;

        await db.collection(HEARTBEAT_COLLECTION).updateOne(
            { _id: HEARTBEAT_DOC_ID },
            {
                $set: {
                    lastSeen: new Date(),
                    lastSeenTs: Math.floor(Date.now() / 1000),
                    version: '1.0',
                    previewMode: ENV.PREVIEW_MODE,
                    trackedAddresses: ENV.USER_ADDRESSES.length,
                },
            },
            { upsert: true }
        );
    } catch (err) {
        // Non-fatal — don't crash the bot over a missed heartbeat
        Logger.warning(`Heartbeat write failed: ${err}`);
    }
}

export function startHeartbeat(): void {
    if (isRunning) return;
    isRunning = true;

    // Write immediately on start
    writeHeartbeat();

    intervalHandle = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
    Logger.info(`Heartbeat started (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
}

export function stopHeartbeat(): void {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
    isRunning = false;
}
