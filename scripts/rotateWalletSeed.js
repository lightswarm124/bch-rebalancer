import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateBip39Mnemonic } from '@bitauth/libauth';
import {
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from 'cashscript';
import { calculateDust } from 'cashscript/dist/utils.js';

import { CAULDRON_TOKEN_ID, NETWORK } from '../config.js';
import { fetchWalletPortfolioSnapshot, deriveWalletKeyMaterial } from '../src/adapters/wallet.js';

const WALLET_PATH = "m/44'/1'/0'/0/0";
const STARTING_CAPITAL_SATS = 4_000_000n;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function loadEnvFile(path = resolve(REPO_ROOT, '.env')) {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf8');
  const entries = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

function writeEnvFile(nextMnemonic, path = resolve(REPO_ROOT, '.env')) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const nextLines = [];
  let replaced = false;
  for (const line of lines) {
    if (line.trim().startsWith('BIP39_MNEMONIC=')) {
      nextLines.push(`BIP39_MNEMONIC=${nextMnemonic}`);
      replaced = true;
      continue;
    }
    nextLines.push(line);
  }
  if (!replaced) {
    nextLines.unshift(`BIP39_MNEMONIC=${nextMnemonic}`);
  }
  writeFileSync(path, `${nextLines.join('\n').replace(/\n+$/, '')}\n`);
}

function cashscriptUtxo(utxo) {
  return {
    txid: String(utxo.txid ?? utxo.tx_hash ?? ''),
    vout: Number(utxo.vout ?? utxo.tx_pos ?? 0),
    satoshis: toBigInt(utxo.satoshis ?? utxo.value ?? 0),
    token: utxo.token
      ? {
          amount: toBigInt(utxo.token.amount ?? 0),
          category: String(utxo.token.category ?? ''),
          nft: utxo.token.nft
            ? {
                capability: utxo.token.nft.capability,
                commitment: String(utxo.token.nft.commitment ?? ''),
              }
            : undefined,
        }
      : undefined,
  };
}

async function main() {
  const currentMnemonic = process.env.BIP39_MNEMONIC ?? '';
  const currentPassphrase = process.env.BIP39_PASSPHRASE ?? '';
  if (!currentMnemonic.trim()) {
    throw new Error('BIP39_MNEMONIC is missing from .env');
  }

  const nextMnemonic = process.env.NEW_BIP39_MNEMONIC?.trim() || generateBip39Mnemonic();
  const nextPassphrase = process.env.NEW_BIP39_PASSPHRASE ?? currentPassphrase;

  const currentWallet = deriveWalletKeyMaterial({
    mnemonic: currentMnemonic,
    passphrase: currentPassphrase,
    path: WALLET_PATH,
  });
  const nextWallet = deriveWalletKeyMaterial({
    mnemonic: nextMnemonic,
    passphrase: nextPassphrase,
    path: WALLET_PATH,
  });

  const snapshot = await fetchWalletPortfolioSnapshot({
    mnemonic: currentMnemonic,
    passphrase: currentPassphrase,
    derivationPath: WALLET_PATH,
    addressLimit: 1,
  });

  const currentUtxos = Array.isArray(snapshot.wallet?.utxos) ? snapshot.wallet.utxos : [];
  const stablecoinCategory = String(CAULDRON_TOKEN_ID);
  const tokenUtxos = currentUtxos.filter(
    (utxo) => String(utxo.token?.category ?? '') === stablecoinCategory && toBigInt(utxo.token?.amount ?? 0n) > 0n
  );
  const bchUtxos = currentUtxos.filter((utxo) => !utxo.token || toBigInt(utxo.token?.amount ?? 0n) === 0n);

  const totalTokens = tokenUtxos.reduce((sum, utxo) => sum + toBigInt(utxo.token?.amount ?? 0n), 0n);
  const tokenBacking = tokenUtxos.reduce((sum, utxo) => sum + toBigInt(utxo.satoshis ?? utxo.value ?? 0n), 0n);
  const totalBch = currentUtxos.reduce((sum, utxo) => sum + toBigInt(utxo.satoshis ?? utxo.value ?? 0n), 0n);

  if (totalTokens <= 0n) {
    throw new Error('No ParyonUSD tokens found to migrate');
  }

  const tokenDust = BigInt(calculateDust({
    to: nextWallet.tokenAddress,
    amount: 0n,
    token: {
      amount: totalTokens,
      category: stablecoinCategory,
    },
  }));

  const provider = new ElectrumNetworkProvider(NETWORK, {
    hostname: (process.env.WALLET_ELECTRUM_SERVERS ?? 'chipnet.bch.ninja').split(/[\n,\s,]+/).filter(Boolean)[0] ?? 'chipnet.bch.ninja',
  });
  const signer = new SignatureTemplate(currentWallet.privateKey);
  const builder = new TransactionBuilder({ provider });

  for (const utxo of currentUtxos) {
    builder.addInput(cashscriptUtxo(utxo), signer.unlockP2PKH());
  }

  builder.addOutput({
    to: nextWallet.tokenAddress,
    amount: tokenDust,
    token: {
      category: stablecoinCategory,
      amount: totalTokens,
    },
  });
  builder.addOutput({
    to: nextWallet.address,
    amount: STARTING_CAPITAL_SATS,
  });
  builder.addBchChangeOutputIfNeeded({
    to: currentWallet.address,
    feeRate: Number(process.env.BROADCAST_FEE_RATE_SATS_PER_BYTE ?? 1),
  });

  console.log('Source wallet:', currentWallet.address);
  console.log('Source token wallet:', currentWallet.tokenAddress);
  console.log('New wallet:', nextWallet.address);
  console.log('New token wallet:', nextWallet.tokenAddress);
  console.log('Total BCH:', totalBch.toString());
  console.log('Token count:', totalTokens.toString());
  console.log('Token backing:', tokenBacking.toString());
  console.log('Starting capital:', STARTING_CAPITAL_SATS.toString());
  console.log('BCH-only inputs:', bchUtxos.length);
  console.log('Preview tx size:', String(builder.getTransactionSize()));

  if (String(process.env.ROTATE_WALLET_BROADCAST ?? '1').trim() !== '1') {
    console.log('Dry run only. Set ROTATE_WALLET_BROADCAST=1 to broadcast and rotate the seed.');
    return;
  }

  const txDetails = await builder.send();
  console.log('Broadcast txid:', txDetails.txid);

  writeEnvFile(nextMnemonic);
  console.log('Updated .env with the new mnemonic.');
  console.log('New wallet is now the default BIP39_MNEMONIC.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
