import {
  cashAddressToLockingBytecode,
  deriveHdPrivateNodeFromSeed,
  deriveHdPath,
  secp256k1,
  encodeCashAddress,
  deriveSeedFromBip39Mnemonic,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { ElectrumClient } from '@electrum-cash/network';
import { createHash } from 'node:crypto';

import { CAULDRON_TOKEN_ID } from '../../config.js';
import { fetchAddressUtxos } from './indexer.js';
import { summarizeAddressUtxos } from '../domain/portfolio.js';

export const DEFAULT_WALLET_DERIVATION_PATH = "m/44'/1'/0'/0/0";
export const DEFAULT_WALLET_ELECTRUM_SERVERS = (
  process.env.WALLET_ELECTRUM_SERVERS ??
  process.env.WALLET_ELECTRUM_SERVER ??
  'chipnet.bch.ninja,chipnet.imaginary.cash,electrum-chipnet.optnlabs.com'
)
  .split(/[\n,\s]+/)
  .map((entry) => entry.trim())
  .filter(Boolean);

function asNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function isInvalidAddressError(error) {
  return String(error instanceof Error ? error.message : error)
    .toLowerCase()
    .includes('invalid address');
}

function addressToElectrumScripthash(address) {
  const lockingBytecode = cashAddressToLockingBytecode(address);
  if (typeof lockingBytecode === 'string') {
    throw new Error(`Invalid address: ${address}`);
  }
  const digest = createHash('sha256')
    .update(Buffer.from(lockingBytecode.bytecode))
    .digest();
  return Buffer.from(digest).reverse().toString('hex');
}

async function fetchAddressUtxosElectrum(address, client) {
  const scripthash = addressToElectrumScripthash(address);
  const tokenAwareResponse = await client.request(
    'blockchain.scripthash.listunspent',
    scripthash,
    'include_tokens'
  );
  if (!(tokenAwareResponse instanceof Error)) {
    return Array.isArray(tokenAwareResponse) ? tokenAwareResponse : [];
  }

  const directResponse = await client.request('blockchain.address.listunspent', address);
  if (!(directResponse instanceof Error)) {
    return Array.isArray(directResponse) ? directResponse : [];
  }

  if (!isInvalidAddressError(directResponse)) {
    throw directResponse;
  }

  throw tokenAwareResponse instanceof Error ? tokenAwareResponse : directResponse;
}

async function fetchAddressHistoryElectrum(address, client) {
  const scripthash = addressToElectrumScripthash(address);
  const tokenAwareResponse = await client.request(
    'blockchain.scripthash.get_history',
    scripthash
  );
  if (!(tokenAwareResponse instanceof Error)) {
    return Array.isArray(tokenAwareResponse) ? tokenAwareResponse : [];
  }

  const directResponse = await client.request('blockchain.address.get_history', address);
  if (!(directResponse instanceof Error)) {
    return Array.isArray(directResponse) ? directResponse : [];
  }

  if (!isInvalidAddressError(directResponse)) {
    throw directResponse;
  }

  throw tokenAwareResponse instanceof Error ? tokenAwareResponse : directResponse;
}

async function fetchWalletAddressUtxos(address, servers) {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error('No electrum servers configured');
  }

  let lastError = null;
  for (const server of servers) {
    const client = new ElectrumClient(
      'CashScript Application',
      '1.4.1',
      server,
      { disableBrowserVisibilityHandling: true }
    );
    try {
      await client.connect();
      const utxos = await fetchAddressUtxosElectrum(address, client);
      if (Array.isArray(utxos)) {
        return utxos;
      }
    } catch (error) {
      lastError = error;
    } finally {
      await client.disconnect(true).catch(() => {});
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
}

async function fetchWalletAddressHistory(address, servers) {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error('No electrum servers configured');
  }

  let lastError = null;
  for (const server of servers) {
    const client = new ElectrumClient(
      'CashScript Application',
      '1.4.1',
      server,
      { disableBrowserVisibilityHandling: true }
    );
    try {
      await client.connect();
      const history = await fetchAddressHistoryElectrum(address, client);
      if (Array.isArray(history)) {
        return history;
      }
    } catch (error) {
      lastError = error;
    } finally {
      await client.disconnect(true).catch(() => {});
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
}

function normalizeElectrumUtxos(address, rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    address,
    height: asNumber(row?.height ?? 0, 0),
    tx_hash: String(row?.tx_hash ?? ''),
    tx_pos: asNumber(row?.tx_pos ?? 0, 0),
    value: asNumber(row?.value ?? 0, 0),
    amount: asNumber(row?.value ?? 0, 0),
    prefix: undefined,
    token: row?.token_data
      ? {
          category: String(row.token_data.category ?? ''),
          amount: String(row.token_data.amount ?? '0'),
        }
      : undefined,
  }));
}

function normalizeElectrumHistory(address, rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const height = asNumber(row?.height ?? 0, 0);
    return {
      address,
      tx_hash: String(row?.tx_hash ?? ''),
      height,
      status: height > 0 ? 'confirmed' : 'mempool',
    };
  });
}

function dedupeUtxos(utxos) {
  const seen = new Set();
  const out = [];
  for (const utxo of utxos) {
    const key = `${utxo.tx_hash}:${utxo.tx_pos}:${utxo.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(utxo);
  }
  return out;
}

function dedupeHistory(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = `${entry.tx_hash}:${entry.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function deriveAddressPair({ mnemonic, passphrase = '', path }) {
  const derived = deriveWalletKeyMaterial({ mnemonic, passphrase, path });
  return {
    path,
    address: derived.address,
    tokenAddress: derived.tokenAddress,
  };
}

export function deriveWalletKeyMaterial({ mnemonic, passphrase = '', path }) {
  const seed = deriveSeedFromBip39Mnemonic(mnemonic, passphrase);
  const rootNode = deriveHdPrivateNodeFromSeed(seed, {
    assumeValidity: true,
    throwErrors: true,
  });
  const node = deriveHdPath(rootNode, path);
  if (typeof node === 'string') {
    throw new Error(`Failed to derive ${path}: ${node}`);
  }
  const publicKey = secp256k1.derivePublicKeyCompressed(node.privateKey);
  const payload = hash160(publicKey);
  const address = encodeCashAddress({
    prefix: 'bchtest',
    type: 'p2pkh',
    payload,
    throwErrors: true,
  }).address;
  const tokenAddress = encodeCashAddress({
    prefix: 'bchtest',
    type: 'p2pkhWithTokens',
    payload,
    throwErrors: true,
  }).address;
  return {
    path,
    privateKey: node.privateKey,
    publicKey,
    publicKeyHash: payload,
    address,
    tokenAddress,
  };
}

function parsePathIndex(path) {
  const parts = String(path ?? '').split('/');
  const last = Number(parts.at(-1));
  return Number.isFinite(last) ? last : 0;
}

export function discoverWalletAddressPairs({
  mnemonic = process.env.BIP39_MNEMONIC ?? '',
  passphrase = process.env.BIP39_PASSPHRASE ?? '',
  derivationPath = process.env.WALLET_DERIVATION_PATH ?? DEFAULT_WALLET_DERIVATION_PATH,
  addressLimit = Number(process.env.WALLET_ADDRESS_SCAN_LIMIT ?? 1),
} = {}) {
  if (!mnemonic.trim()) {
    return [];
  }

  const pathParts = derivationPath.split('/');
  const basePath = pathParts.slice(0, -1).join('/');
  const startIndex = Number(pathParts[pathParts.length - 1] ?? 0);
  if (!basePath || !Number.isFinite(startIndex)) {
    throw new Error(`Invalid BIP44 wallet derivation path: ${derivationPath}`);
  }

  const pairs = [];
  const seen = new Set();
  for (let offset = 0; offset < addressLimit; offset += 1) {
    const path = `${basePath}/${startIndex + offset}`;
    const pair = deriveAddressPair({ mnemonic, passphrase, path });
    const key = `${pair.address}:${pair.tokenAddress}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(pair);
  }
  return pairs;
}

export async function fetchWalletPortfolioSnapshot({
  baseUrl,
  stablecoinCategory = CAULDRON_TOKEN_ID,
  mnemonic = process.env.BIP39_MNEMONIC ?? '',
  passphrase = process.env.BIP39_PASSPHRASE ?? '',
  addressLimit = Number(process.env.WALLET_ADDRESS_SCAN_LIMIT ?? 1),
  derivationPath = process.env.WALLET_DERIVATION_PATH ?? DEFAULT_WALLET_DERIVATION_PATH,
  electrumServers = DEFAULT_WALLET_ELECTRUM_SERVERS,
} = {}) {
  const derivedPairs = discoverWalletAddressPairs({
    mnemonic,
    passphrase,
    derivationPath,
    addressLimit,
  });
  const addressPairs = derivedPairs;

  const primaryServer = Array.isArray(electrumServers) ? electrumServers[0] ?? '' : '';
  const pairResults = await Promise.all(
    addressPairs.map(async (pair) => {
      const [tokenAwareUtxos, tokenAwareHistory] = await Promise.all([
        fetchWalletAddressUtxos(pair.address, electrumServers)
          .then((rows) => normalizeElectrumUtxos(pair.address, rows))
          .catch(() => fetchAddressUtxos(pair.address, { baseUrl }).catch(() => [])),
        fetchWalletAddressHistory(pair.address, electrumServers)
          .then((rows) => normalizeElectrumHistory(pair.address, rows))
          .catch(() => []),
      ]);
      return {
        pair,
        bchUtxos: tokenAwareUtxos.filter((utxo) => !utxo.token),
        tokenUtxos: tokenAwareUtxos.filter((utxo) => utxo.token),
        utxos: dedupeUtxos(tokenAwareUtxos),
        history: tokenAwareHistory,
      };
    })
  );
  const utxos = pairResults.flatMap((result) => result.utxos);
  const txHistory = dedupeHistory(pairResults.flatMap((result) => result.history));
  const summary = summarizeAddressUtxos(utxos, { stablecoinCategory });
  const discoveredPairs = pairResults.filter(
    (result) => result.bchUtxos.length > 0 || result.tokenUtxos.length > 0
  ).map((result) => result.pair);
  const bchUtxos = pairResults.flatMap((result) => result.bchUtxos);
  const tokenUtxos = pairResults.flatMap((result) => result.tokenUtxos);

  return {
    ok: true,
    mode: 'live',
    baseUrl,
    scannedPairs: addressPairs.length,
    discoveredPairs,
    utxos,
    wallet: {
      derivationPath,
      primaryAddress: addressPairs[0]?.address ?? '',
      primaryTokenAddress: addressPairs[0]?.tokenAddress ?? '',
      primaryPathIndex: parsePathIndex(addressPairs[0]?.path),
      addressPairs,
      discoveredPairs,
      electrumServers,
      primaryElectrumServer: primaryServer,
      utxos,
      bchUtxos,
      tokenUtxos,
      txHistory,
      txHistoryCount: txHistory.length,
      utxoCount: summary.utxoCount,
      bchSats: summary.bchSats,
      stablecoinTokens: summary.stablecoinTokens,
      stablecoinUtxos: summary.stablecoinUtxos,
      nftCount: summary.nftCount,
      nftUtxos: summary.nftUtxos,
    },
    totals: {
      totalBchSats: summary.bchSats,
      totalStablecoinTokens: summary.stablecoinTokens,
    },
  };
}
