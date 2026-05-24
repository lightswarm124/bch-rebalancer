import { binToHex, hash256, hexToBin } from '@bitauth/libauth';

const POOL_V0_PRE_PUBKEY_BIN = hexToBin('44746376a914');
const POOL_V0_PUBKEY_SIZE = 20;
const POOL_V0_POST_PUBKEY_BIN = hexToBin(
  '88ac67c0d1c0ce88c25288c0cdc0c788c0c6c0d095c0c6c0cc9490539502e80396c0cc7c94c0d3957ca268'
);
const POOL_V0_UNLOCKING_SIZE =
  POOL_V0_PRE_PUBKEY_BIN.length +
  POOL_V0_PUBKEY_SIZE +
  POOL_V0_POST_PUBKEY_BIN.length;

function normalizeHex(value) {
  return String(value ?? '').trim().replace(/^0x/i, '').toLowerCase();
}

function ensureWithdrawPublicKeyHash(withdrawPublicKeyHash) {
  const normalized = normalizeHex(
    typeof withdrawPublicKeyHash === 'string'
      ? withdrawPublicKeyHash
      : Buffer.from(withdrawPublicKeyHash ?? []).toString('hex')
  );
  if (normalized.length !== POOL_V0_PUBKEY_SIZE * 2) {
    throw new Error('Cauldron withdraw public key hash must be 20 bytes');
  }
  return hexToBin(normalized);
}

export function buildCauldronPoolV0RedeemScript({ withdrawPublicKeyHash }) {
  const hash = ensureWithdrawPublicKeyHash(withdrawPublicKeyHash);
  return Uint8Array.from([
    ...POOL_V0_PRE_PUBKEY_BIN.slice(1),
    ...hash,
    ...POOL_V0_POST_PUBKEY_BIN,
  ]);
}

export function buildCauldronPoolV0ExchangeUnlockingBytecode({
  withdrawPublicKeyHash,
}) {
  const hash = ensureWithdrawPublicKeyHash(withdrawPublicKeyHash);
  return Uint8Array.from([
    ...POOL_V0_PRE_PUBKEY_BIN,
    ...hash,
    ...POOL_V0_POST_PUBKEY_BIN,
  ]);
}

export function buildCauldronPoolV0LockingBytecode({
  withdrawPublicKeyHash,
}) {
  const redeemScript = buildCauldronPoolV0RedeemScript({ withdrawPublicKeyHash });
  const payload = hash256(redeemScript);
  return Uint8Array.from([0xaa, payload.length, ...payload, 0x87]);
}

export function validateLiveCauldronPoolShape(pool) {
  const ownerPkh = normalizeHex(pool?.owner_pkh ?? pool?.ownerPkh ?? '');
  if (!ownerPkh) {
    return {
      ok: false,
      error: 'Missing pool owner public key hash',
      expectedLockingBytecode: null,
      actualLockingBytecode: null,
      ownerPkh: null,
    };
  }

  const expectedLockingBytecode = Buffer.from(
    buildCauldronPoolV0LockingBytecode({
      withdrawPublicKeyHash: ownerPkh,
    })
  ).toString('hex');
  const actualLockingBytecode = normalizeHex(
    pool?.locking_bytecode ?? pool?.lockingBytecode ?? ''
  );
  const hasActualLockingBytecode = actualLockingBytecode.length > 0;
  return {
    ok: !hasActualLockingBytecode || expectedLockingBytecode === actualLockingBytecode,
    expectedLockingBytecode,
    actualLockingBytecode: hasActualLockingBytecode ? actualLockingBytecode : null,
    ownerPkh,
    error:
      !hasActualLockingBytecode || expectedLockingBytecode === actualLockingBytecode
        ? null
        : 'Live pool locking bytecode does not match the expected Cauldron V0 shape',
  };
}

export function poolIdentity(pool) {
  return String(pool?.pool_id ?? pool?.poolId ?? pool?.txid ?? pool?.txHash ?? '');
}
