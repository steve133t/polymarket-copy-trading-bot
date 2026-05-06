import { NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';
import { spawn } from 'child_process';
import * as path from 'path';

export async function POST() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        return NextResponse.json({ error: 'MONGO_URI not configured' }, { status: 500 });
    }

    let pid: number | null = null;
    try {
        const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });
        await client.connect();
        const doc = await client.db().collection('bot_heartbeat').findOne({ _id: 'main' as any });
        await client.close();
        pid = doc?.pid ?? null;
    } catch {
        // continue — we'll try to start the bot even if we can't stop the old one
    }

    // Stop running instance
    if (pid) {
        try {
            process.kill(pid, 'SIGTERM');
            // Brief pause to let it shut down
            await new Promise(r => setTimeout(r, 2000));
        } catch {
            // ESRCH = already dead, that's fine
        }
    }

    // Restart bot from its working directory
    const botDir = path.join(process.cwd(), '..');
    // Build the entry-point path at runtime so bundlers don't try to statically resolve it
    const entryPoint = ['dist', 'index.js'].join(path.sep);
    const child = spawn('node', [entryPoint], {
        cwd: botDir,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
    });
    child.unref();

    return NextResponse.json({
        success: true,
        message: 'Bot restarting...',
        previousPid: pid,
        newPid: child.pid ?? null,
    });
}
