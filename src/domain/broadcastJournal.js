import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const JOURNAL_PATH = resolve(PROJECT_ROOT, '.cache', 'bch-rebalancer', 'last-broadcast.json');

export function getBroadcastJournalPath() {
  return JOURNAL_PATH;
}

export async function readLastBroadcastRecord() {
  try {
    const raw = await readFile(JOURNAL_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeLastBroadcastRecord(record) {
  const payload = {
    txid: String(record?.txid ?? ''),
    broadcastAt: Number(record?.broadcastAt ?? Date.now()),
    direction: String(record?.direction ?? 'n/a'),
    poolCount: Number(record?.poolCount ?? 0),
    slippageBps: record?.slippageBps === null || record?.slippageBps === undefined
      ? null
      : Number(record.slippageBps),
    status: String(record?.status ?? 'broadcasted'),
  };

  if (!payload.txid) {
    return null;
  }

  await mkdir(dirname(JOURNAL_PATH), { recursive: true });
  await writeFile(JOURNAL_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}
