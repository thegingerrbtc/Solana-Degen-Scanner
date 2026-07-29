#!/usr/bin/env node
'use strict';

/**
 * Read-only Solana deterministic wallet inventory scanner.
 *
 * This program derives public addresses locally and only calls explicitly
 * allowlisted read RPC methods. It contains no transaction construction,
 * signing, simulation, or submission path.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const READ_METHODS = new Set([
  'getBalance',
  'getTokenAccountsByOwner',
  'getAssetsByOwner',
]);

const DEFAULTS = Object.freeze({
  rpc: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  dasRpc: process.env.SOLANA_DAS_RPC_URL || '',
  count: 200,
  start: 0,
  pathTemplate: "m/44'/501'/{index}'/0'",
  output: './inventory',
  commitment: 'finalized',
  batchSize: 10,
  retries: 5,
  includeZero: false,
  dasConcurrency: 4,
  dasPageSize: 1000,
});

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function help() {
  console.log(`
Solana read-only wallet inventory

Usage:
  node solana_inventory.cjs --seeds ./seedphrases.txt [options]

Required:
  --seeds <file>              One BIP-39 mnemonic per non-comment line

Options:
  --rpc <url>                 Standard Solana RPC endpoint
  --das-rpc <url>             Optional DAS-compatible endpoint
  --count <n>                 Addresses per mnemonic (default: 200)
  --start <n>                 Starting account index (default: 0)
  --path-template <template>  Hardened path containing {index}
                              default: m/44'/501'/{index}'/0'
  --output <prefix>           Output prefix (default: ./inventory)
  --commitment <level>        processed|confirmed|finalized
  --batch-size <n>            Wallets per standard-RPC batch (default: 10)
  --retries <n>               Retry count (default: 5)
  --include-zero              Include zero SOL/token balances
  --das-concurrency <n>       Parallel DAS wallet requests (default: 4)
  --das-page-size <n>         DAS page size (default: 1000)
  -h, --help                  Show this help

Environment:
  SOLANA_RPC_URL
  SOLANA_DAS_RPC_URL
  BIP39_PASSPHRASE
`.trim());
}

function integer(value, name, allowZero = false) {
  if (!/^\d+$/.test(value)) fail(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    fail(`${name} is out of range`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, seeds: '' };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail(`missing value for ${arg}`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '-h':
      case '--help':
        help();
        process.exit(0);
        break;
      case '--seeds':
        options.seeds = take();
        break;
      case '--rpc':
        options.rpc = take();
        break;
      case '--das-rpc':
        options.dasRpc = take();
        break;
      case '--count':
        options.count = integer(take(), '--count');
        break;
      case '--start':
        options.start = integer(take(), '--start', true);
        break;
      case '--path-template':
        options.pathTemplate = take();
        break;
      case '--output':
        options.output = take();
        break;
      case '--commitment':
        options.commitment = take();
        break;
      case '--batch-size':
        options.batchSize = integer(take(), '--batch-size');
        break;
      case '--retries':
        options.retries = integer(take(), '--retries', true);
        break;
      case '--include-zero':
        options.includeZero = true;
        break;
      case '--das-concurrency':
        options.dasConcurrency = integer(take(), '--das-concurrency');
        break;
      case '--das-page-size':
        options.dasPageSize = integer(take(), '--das-page-size');
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (!options.seeds) fail('--seeds is required');
  if (!options.pathTemplate.includes('{index}')) {
    fail('--path-template must contain {index}');
  }
  if (!['processed', 'confirmed', 'finalized'].includes(options.commitment)) {
    fail('--commitment must be processed, confirmed, or finalized');
  }

  return options;
}

function normalizeMnemonic(value) {
  return value.normalize('NFKD').trim().replace(/\s+/gu, ' ');
}

function loadMnemonics(filename) {
  const lines = fs.readFileSync(path.resolve(filename), 'utf8').split(/\r?\n/);
  const acceptedCounts = new Set([12, 15, 18, 21, 24]);
  const found = [];
  const seen = new Set();

  lines.forEach((line, offset) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) return;

    const mnemonic = normalizeMnemonic(raw);
    const words = mnemonic.split(' ').length;
    if (!acceptedCounts.has(words)) {
      fail(`line ${offset + 1} has ${words} words; expected 12, 15, 18, 21, or 24`);
    }
    if (seen.has(mnemonic)) {
      console.error(`Warning: duplicate mnemonic skipped on line ${offset + 1}`);
      return;
    }

    seen.add(mnemonic);
    found.push(mnemonic);
  });

  if (found.length === 0) fail('seed file contains no mnemonic phrases');
  return found;
}

function mnemonicSeed(mnemonic) {
  const passphrase = process.env.BIP39_PASSPHRASE || '';
  return crypto.pbkdf2Sync(
    Buffer.from(mnemonic.normalize('NFKD'), 'utf8'),
    Buffer.from(`mnemonic${passphrase}`.normalize('NFKD'), 'utf8'),
    2048,
    64,
    'sha512'
  );
}

function hardenedIndexes(derivationPath) {
  const pieces = derivationPath.split('/');
  if (pieces.shift() !== 'm') fail(`invalid derivation path: ${derivationPath}`);

  return pieces.map((piece) => {
    const match = /^(\d+)(?:'|h|H)$/.exec(piece);
    if (!match) fail(`all Ed25519 path components must be hardened: ${derivationPath}`);
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 0 || value >= 0x80000000) {
      fail(`path component out of range: ${piece}`);
    }
    return value;
  });
}

function derivePrivateSeed(seed, derivationPath) {
  let material = crypto
    .createHmac('sha512', Buffer.from('ed25519 seed'))
    .update(seed)
    .digest();

  let key = Buffer.from(material.subarray(0, 32));
  let chain = Buffer.from(material.subarray(32));
  material.fill(0);

  try {
    for (const index of hardenedIndexes(derivationPath)) {
      const data = Buffer.alloc(37);
      data[0] = 0;
      key.copy(data, 1);
      data.writeUInt32BE(index + 0x80000000, 33);

      material = crypto.createHmac('sha512', chain).update(data).digest();
      data.fill(0);
      key.fill(0);
      chain.fill(0);

      key = Buffer.from(material.subarray(0, 32));
      chain = Buffer.from(material.subarray(32));
      material.fill(0);
    }

    return Buffer.from(key);
  } finally {
    key.fill(0);
    chain.fill(0);
    if (material) material.fill(0);
  }
}

function publicKeyFromPrivateSeed(privateSeed) {
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const encoded = Buffer.concat([prefix, privateSeed]);
  try {
    const privateObject = crypto.createPrivateKey({
      key: encoded,
      format: 'der',
      type: 'pkcs8',
    });
    const publicDer = crypto.createPublicKey(privateObject).export({
      format: 'der',
      type: 'spki',
    });
    return Buffer.from(publicDer).subarray(publicDer.length - 32);
  } finally {
    encoded.fill(0);
  }
}

function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const input = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros += 1;

  let value = input.length ? BigInt(`0x${input.toString('hex')}`) : 0n;
  let output = '';

  while (value > 0n) {
    output = alphabet[Number(value % 58n)] + output;
    value /= 58n;
  }

  return '1'.repeat(zeros) + output;
}

function deriveWallets(mnemonic, seedIndex, options) {
  const seed = mnemonicSeed(mnemonic);
  const wallets = [];

  try {
    for (let offset = 0; offset < options.count; offset += 1) {
      const accountIndex = options.start + offset;
      const derivationPath = options.pathTemplate.replaceAll(
        '{index}',
        String(accountIndex)
      );
      const privateSeed = derivePrivateSeed(seed, derivationPath);

      try {
        wallets.push({
          seed_index: seedIndex,
          account_index: accountIndex,
          derivation_path: derivationPath,
          address: base58(publicKeyFromPrivateSeed(privateSeed)),
          sol_lamports: '0',
          sol: '0',
          assets: [],
          das_assets: [],
          rpc_error: null,
          das_error: null,
        });
      } finally {
        privateSeed.fill(0);
      }
    }
  } finally {
    seed.fill(0);
  }

  return wallets;
}

function units(raw, decimals) {
  let value = BigInt(raw);
  const negative = value < 0n;
  if (negative) value = -value;

  const digits = value.toString().padStart(decimals + 1, '0');
  if (decimals === 0) return `${negative ? '-' : ''}${digits}`;

  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertReadMethod(method) {
  if (!READ_METHODS.has(method)) fail(`blocked non-read RPC method: ${method}`);
}

async function postJson(url, payload, retries) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'solana-degen-scanner-readonly/1.0',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      }

      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(Math.min(30_000, 500 * (2 ** attempt)) + Math.random() * 250);
    }
  }

  throw lastError;
}

async function rpcCall(url, method, params, retries, id) {
  assertReadMethod(method);
  const response = await postJson(
    url,
    { jsonrpc: '2.0', id, method, params },
    retries
  );
  if (response.error) {
    throw new Error(response.error.message || JSON.stringify(response.error));
  }
  return response.result;
}

async function rpcBatch(url, calls, retries) {
  calls.forEach((call) => assertReadMethod(call.method));
  const payload = calls.map((call) => ({
    jsonrpc: '2.0',
    id: call.id,
    method: call.method,
    params: call.params,
  }));

  try {
    const response = await postJson(url, payload, retries);
    if (!Array.isArray(response)) throw new Error('batch response was not an array');
    return new Map(response.map((entry) => [String(entry.id), entry]));
  } catch (batchError) {
    const entries = await Promise.all(payload.map(async (call) => {
      try {
        const result = await rpcCall(
          url,
          call.method,
          call.params,
          retries,
          call.id
        );
        return [String(call.id), { id: call.id, result }];
      } catch (error) {
        return [
          String(call.id),
          { id: call.id, error: { message: `${error.message}; batch: ${batchError.message}` } },
        ];
      }
    }));
    return new Map(entries);
  }
}

function aggregateTokens(result, tokenProgram, includeZero) {
  const rows = Array.isArray(result?.value) ? result.value : [];
  const grouped = new Map();

  for (const row of rows) {
    const info = row?.account?.data?.parsed?.info;
    const amount = info?.tokenAmount;
    if (!info?.mint || typeof amount?.amount !== 'string') continue;

    const raw = BigInt(amount.amount);
    if (raw === 0n && !includeZero) continue;

    const key = `${tokenProgram}:${info.mint}`;
    const decimals = Number(amount.decimals || 0);
    const existing = grouped.get(key) || {
      asset_type: tokenProgram === LEGACY_TOKEN_PROGRAM ? 'SPL_TOKEN' : 'TOKEN_2022',
      mint: info.mint,
      token_program: tokenProgram,
      decimals,
      amount_raw_value: 0n,
      token_accounts: [],
    };

    existing.amount_raw_value += raw;
    existing.token_accounts.push({
      address: row.pubkey,
      amount_raw: amount.amount,
      amount: amount.uiAmountString || units(raw, decimals),
      state: info.state || null,
      delegate: info.delegate || null,
    });
    grouped.set(key, existing);
  }

  return [...grouped.values()].map((asset) => {
    const amountRaw = asset.amount_raw_value;
    delete asset.amount_raw_value;
    return {
      ...asset,
      amount_raw: amountRaw.toString(),
      amount: units(amountRaw, asset.decimals),
      classification:
        asset.decimals === 0 && amountRaw === 1n
          ? 'NFT_OR_SINGLE_UNIT_TOKEN'
          : 'FUNGIBLE_OR_MULTI_UNIT_TOKEN',
    };
  });
}

async function scanStandardRpc(wallets, options) {
  for (let start = 0; start < wallets.length; start += options.batchSize) {
    const chunk = wallets.slice(start, start + options.batchSize);
    const calls = [];

    chunk.forEach((wallet, offset) => {
      const key = String(start + offset);
      calls.push({
        id: `${key}:balance`,
        method: 'getBalance',
        params: [wallet.address, { commitment: options.commitment }],
      });
      for (const [label, program] of [
        ['legacy', LEGACY_TOKEN_PROGRAM],
        ['token2022', TOKEN_2022_PROGRAM],
      ]) {
        calls.push({
          id: `${key}:${label}`,
          method: 'getTokenAccountsByOwner',
          params: [
            wallet.address,
            { programId: program },
            { encoding: 'jsonParsed', commitment: options.commitment },
          ],
        });
      }
    });

    const responses = await rpcBatch(options.rpc, calls, options.retries);

    chunk.forEach((wallet, offset) => {
      const key = String(start + offset);
      const balance = responses.get(`${key}:balance`);
      const legacy = responses.get(`${key}:legacy`);
      const token2022 = responses.get(`${key}:token2022`);
      const errors = [];

      for (const [name, response] of [
        ['balance', balance],
        ['legacy tokens', legacy],
        ['Token-2022', token2022],
      ]) {
        if (!response) errors.push(`${name}: missing response`);
        else if (response.error) {
          errors.push(`${name}: ${response.error.message || JSON.stringify(response.error)}`);
        }
      }

      if (balance?.result?.value !== undefined) {
        const lamports = BigInt(balance.result.value);
        wallet.sol_lamports = lamports.toString();
        wallet.sol = units(lamports, 9);
      }

      wallet.assets = [
        ...aggregateTokens(legacy?.result, LEGACY_TOKEN_PROGRAM, options.includeZero),
        ...aggregateTokens(token2022?.result, TOKEN_2022_PROGRAM, options.includeZero),
      ];
      wallet.rpc_error = errors.length ? errors.join(' | ') : null;
    });

    console.error(`RPC ${Math.min(start + chunk.length, wallets.length)}/${wallets.length}`);
  }
}

function normalizeDasAsset(asset) {
  const metadata = asset?.content?.metadata || {};
  const tokenInfo = asset?.token_info || {};
  const collection = Array.isArray(asset?.grouping)
    ? asset.grouping.find((group) => group.group_key === 'collection')?.group_value
    : null;

  return {
    id: asset?.id || null,
    interface: asset?.interface || null,
    name: metadata.name || null,
    symbol: metadata.symbol || tokenInfo.symbol || null,
    json_uri: asset?.content?.json_uri || null,
    compressed: Boolean(asset?.compression?.compressed),
    burnt: Boolean(asset?.burnt),
    owner: asset?.ownership?.owner || null,
    frozen: asset?.ownership?.frozen ?? null,
    token_program: tokenInfo.token_program || null,
    balance_raw: tokenInfo.balance !== undefined ? String(tokenInfo.balance) : null,
    decimals: tokenInfo.decimals ?? null,
    collection: collection || null,
  };
}

async function scanDasWallet(wallet, options) {
  let page = 1;
  const items = [];

  try {
    while (true) {
      const result = await rpcCall(
        options.dasRpc,
        'getAssetsByOwner',
        {
          ownerAddress: wallet.address,
          page,
          limit: options.dasPageSize,
          displayOptions: {
            showFungible: true,
            showNativeBalance: true,
            showInscription: true,
          },
        },
        options.retries,
        `das:${wallet.seed_index}:${wallet.account_index}:${page}`
      );

      const pageItems = Array.isArray(result?.items) ? result.items : [];
      items.push(...pageItems);

      const total = Number(result?.total ?? items.length);
      if (
        pageItems.length === 0 ||
        pageItems.length < options.dasPageSize ||
        items.length >= total
      ) {
        break;
      }
      page += 1;
    }

    wallet.das_assets = items.map(normalizeDasAsset);
  } catch (error) {
    wallet.das_error = error.message;
  }
}

async function mapLimit(items, limit, worker) {
  let next = 0;
  let completed = 0;

  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]);
      completed += 1;
      if (completed === items.length || completed % 10 === 0) {
        console.error(`DAS ${completed}/${items.length}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run())
  );
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(headers, rows) {
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(',')),
    '',
  ].join('\n');
}

function writeOutputs(report, options) {
  const prefix = path.resolve(options.output);
  fs.mkdirSync(path.dirname(prefix), { recursive: true });

  const walletRows = report.wallets.map((wallet) => ({
    seed_index: wallet.seed_index,
    account_index: wallet.account_index,
    derivation_path: wallet.derivation_path,
    address: wallet.address,
    sol_lamports: wallet.sol_lamports,
    sol: wallet.sol,
    raw_asset_count: wallet.assets.length,
    das_asset_count: wallet.das_assets.length,
    rpc_error: wallet.rpc_error,
    das_error: wallet.das_error,
  }));

  const assetRows = [];
  const dasRows = [];

  for (const wallet of report.wallets) {
    if (options.includeZero || BigInt(wallet.sol_lamports) !== 0n) {
      assetRows.push({
        seed_index: wallet.seed_index,
        account_index: wallet.account_index,
        derivation_path: wallet.derivation_path,
        owner_address: wallet.address,
        asset_type: 'SOL',
        mint: 'SOL',
        token_program: 'SystemProgram',
        amount_raw: wallet.sol_lamports,
        decimals: 9,
        amount: wallet.sol,
        classification: 'NATIVE',
        token_accounts: '',
      });
    }

    for (const asset of wallet.assets) {
      assetRows.push({
        seed_index: wallet.seed_index,
        account_index: wallet.account_index,
        derivation_path: wallet.derivation_path,
        owner_address: wallet.address,
        asset_type: asset.asset_type,
        mint: asset.mint,
        token_program: asset.token_program,
        amount_raw: asset.amount_raw,
        decimals: asset.decimals,
        amount: asset.amount,
        classification: asset.classification,
        token_accounts: asset.token_accounts.map((account) => account.address).join(';'),
      });
    }

    for (const asset of wallet.das_assets) {
      dasRows.push({
        seed_index: wallet.seed_index,
        account_index: wallet.account_index,
        derivation_path: wallet.derivation_path,
        owner_address: wallet.address,
        id: asset.id,
        interface: asset.interface,
        name: asset.name,
        symbol: asset.symbol,
        compressed: asset.compressed,
        burnt: asset.burnt,
        token_program: asset.token_program,
        balance_raw: asset.balance_raw,
        decimals: asset.decimals,
        collection: asset.collection,
        json_uri: asset.json_uri,
      });
    }
  }

  const jsonFile = `${prefix}.json`;
  const walletFile = `${prefix}_wallets.csv`;
  const assetFile = `${prefix}_assets.csv`;
  const dasFile = `${prefix}_das_assets.csv`;

  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    walletFile,
    csv(
      [
        'seed_index',
        'account_index',
        'derivation_path',
        'address',
        'sol_lamports',
        'sol',
        'raw_asset_count',
        'das_asset_count',
        'rpc_error',
        'das_error',
      ],
      walletRows
    ),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    assetFile,
    csv(
      [
        'seed_index',
        'account_index',
        'derivation_path',
        'owner_address',
        'asset_type',
        'mint',
        'token_program',
        'amount_raw',
        'decimals',
        'amount',
        'classification',
        'token_accounts',
      ],
      assetRows
    ),
    { mode: 0o600 }
  );

  if (options.dasRpc) {
    fs.writeFileSync(
      dasFile,
      csv(
        [
          'seed_index',
          'account_index',
          'derivation_path',
          'owner_address',
          'id',
          'interface',
          'name',
          'symbol',
          'compressed',
          'burnt',
          'token_program',
          'balance_raw',
          'decimals',
          'collection',
          'json_uri',
        ],
        dasRows
      ),
      { mode: 0o600 }
    );
  }

  return { jsonFile, walletFile, assetFile, dasFile: options.dasRpc ? dasFile : null };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mnemonics = loadMnemonics(options.seeds);
  const wallets = [];

  console.error(
    `Loaded ${mnemonics.length} mnemonic(s); deriving ${options.count} addresses each`
  );

  for (let seedIndex = 0; seedIndex < mnemonics.length; seedIndex += 1) {
    console.error(`Seed ${seedIndex + 1}/${mnemonics.length}: derive`);
    const derived = deriveWallets(mnemonics[seedIndex], seedIndex, options);
    mnemonics[seedIndex] = '';
    await scanStandardRpc(derived, options);

    if (options.dasRpc) {
      await mapLimit(
        derived,
        options.dasConcurrency,
        (wallet) => scanDasWallet(wallet, options)
      );
    }

    wallets.push(...derived);
  }

  const report = {
    generated_at: new Date().toISOString(),
    transaction_capability: false,
    read_only_rpc_methods: [...READ_METHODS],
    rpc: options.rpc,
    das_enabled: Boolean(options.dasRpc),
    mnemonic_count: mnemonics.length,
    addresses_per_mnemonic: options.count,
    start_index: options.start,
    path_template: options.pathTemplate,
    commitment: options.commitment,
    wallets,
  };

  const files = writeOutputs(report, options);
  console.error('Completed');
  console.error(`JSON: ${files.jsonFile}`);
  console.error(`Wallet CSV: ${files.walletFile}`);
  console.error(`Asset CSV: ${files.assetFile}`);
  if (files.dasFile) console.error(`DAS CSV: ${files.dasFile}`);
}

main().catch((error) => {
  console.error(`Fatal: ${error.stack || error.message}`);
  process.exitCode = 1;
});
