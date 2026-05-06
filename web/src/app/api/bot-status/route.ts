import { NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI!;
const HEARTBEAT_COLLECTION = 'bot_heartbeat';
const HEARTBEAT_DOC_ID = 'main';
const STALE_THRESHOLD_SECONDS = 90; // bot is considered offline after 90s with no heartbeat

let client: MongoClient | null = null;

async function getDb() {
  if (!client) {
    client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
    });
    await client.connect();
  }
  return client.db();
}

export type BotStatusResponse = {
  online: boolean;
  lastSeen: string | null;
  lastSeenTs: number | null;
  secondsSinceHeartbeat: number | null;
  previewMode: boolean | null;
  trackedAddresses: number | null;
  error?: string;
};

export async function GET() {
  try {
    const db = await getDb();
    const doc = await db
      .collection(HEARTBEAT_COLLECTION)
      .findOne({ _id: HEARTBEAT_DOC_ID as any });

    if (!doc) {
      return NextResponse.json<BotStatusResponse>({
        online: false,
        lastSeen: null,
        lastSeenTs: null,
        secondsSinceHeartbeat: null,
        previewMode: null,
        trackedAddresses: null,
      });
    }

    const lastSeenTs: number = doc.lastSeenTs ?? 0;
    const nowTs = Math.floor(Date.now() / 1000);
    const secondsSince = nowTs - lastSeenTs;
    const online = secondsSince <= STALE_THRESHOLD_SECONDS;

    return NextResponse.json<BotStatusResponse>({
      online,
      lastSeen: doc.lastSeen ? new Date(doc.lastSeen).toISOString() : null,
      lastSeenTs,
      secondsSinceHeartbeat: secondsSince,
      previewMode: doc.previewMode ?? null,
      trackedAddresses: doc.trackedAddresses ?? null,
    });
  } catch (err) {
    return NextResponse.json<BotStatusResponse>(
      {
        online: false,
        lastSeen: null,
        lastSeenTs: null,
        secondsSinceHeartbeat: null,
        previewMode: null,
        trackedAddresses: null,
        error: String(err),
      },
      { status: 500 }
    );
  }
}
