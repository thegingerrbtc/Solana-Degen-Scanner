#!/usr/bin/env node
'use strict';

/**
 * Read-only Solana token-account rent checker.
 *
 * Input is an inventory JSON file produced by solana_inventory.cjs, or a text
 * file containing one public address per line. No seed phrases or private keys
 * are required. This tool only calls read-only JSON-RPC methods.
 */

const fs = require('node:fs');
const path = require('node:path');

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const READ_ONLY_RPC_METHODS = new Set([
  'getTokenAccountsByOwner',
  'getMinimumBalanceForRentExemption',
]);

const DEFAULTS = Object.freeze({
  rpc: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  output: './rent_report',
  commitment: 'finalized',
  batchWallets: 10,
  retries: 5,
});

function usage(exitCode = 0) {
  console.log(`
Solana token-account rent checker

Usage:
  node rent_checker.cjs --inventory ./inventory.json [options]
  node rent_checker.cjs --addresses ./addresses.txt [options]

Required, choose one:
  --inventory <file>       JSON produced by solana_inventory.cjs
  --addresses <file>       One public address per line; # comments allowed

Options:
  --rpc <url>              Solana RPC URL
  --output <prefix>        Output prefix. Default: ./rent_report
  --commitment <level>     processed|confirmed|finalized. Default: finalized
  --batch-wallets <n>      Wallets per RPC batch. Default: 10
  --retries <n>            RPC retry count. Default: 5
  -h, --help               Show this help

Outputs:
  <prefix>.json
  <prefix>_wallets.csv
  <prefix>_accounts.csv

The checker does not construct, sign, simulate, or submit transactions.
`.trim());
  process.exit(exitCode);
}

function integer(raw, name, allowZero = false) {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} is out of range`);
  }
  return value;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, inventory: '', addresses: '' };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}`);
      }
      index += 1;
      return value;
    };

    switch (argument) {
      case '-h':
      case '--help':
        usage(0);
        break;
      case '--inventory':
        options.inventory = take();
        break;
      case '--addresses':
        options.addresses = take();
        break;
      case '--rpc':
        options.rpc = take();
        break;
      case '--output':
        options.output = take();
        break;
      case '--commitment':
        options.commitment = take().toLowerCase();
        break;
      case '--batch-wallets':
        options.batchWallets = integer(take(), '--batch-wallets');
        break;
      case '--retries':
        options.retries = integer(take(), '--retries', true);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (Boolean(options.inventory) === Boolean(options.addresses)) {
    throw new Error('Specify exactly one of --inventory or --addresses');
  }
  if (!['processed', 'confirmed', 'finalized'].includes(options.commitment)) {
    throw new Error('--commitment must be processed, confirmed, or finalized');
  }

  return options;
}

function loadWallets(options) {
  if (options.inventory) {
    const report = JSON.parse(fs.readFileSync(path.resolve(options.inventory), 'utf8'));
    if (!Array.isArray(report.wallets)) {
      throw new Error('Inventory JSON does not contain a wallets array');
    }

    const seen = new Set();
    return report.wallets.flatMap((wallet, offset) => {
      const address = String(wallet?.address || '').trim();
      if (!address || seen.has(address)) return [];
      seen.add(address);
      return [{
        seed_index: wallet.seed_index ?? null,
        account_index: wallet.account_index ?? offset,
        derivation_path: wallet.derivation_path ?? null,
        address,
        token_accounts: [],
        rent_summary: null,
        rpc_error: null,
      }];
    });
  }

  const lines = fs.readFileSync(path.resolve(options.addresses), 'utf8').split(/\r?\n/);
  const seen = new Set();
  const wallets = [];

  for (const line of lines) {
    const address = line.trim();
    if (!address || address.startsWith('#') || seen.has(address)) continue;
    seen.add(address);
    wallets.push({
      seed_index: null,
      account_index: wallets.length,
      derivation_path: null,
      address,
      token_accounts: [],
      rent_summary: null,
      rpc_error: null,
    });
  }

  if (wallets.length === 0) throw new Error('No public addresses found');
  return wallets;
}

function formatUnits(value, decimals) {
  let raw = BigInt(value);
  const negative = raw < 0n;
  if (negative) raw = -raw;
  let digits = raw.toString();
  if (decimals === 0) return `${negative ? '-' : ''}${digits}`;
  digits = digits.padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertReadOnly(method) {
  if (!READ_ONLY_RPC_METHODS.has(method)) {
    throw new Error(`Blocked non-read RPC method: ${method}`);
  }
}

async function postJson(url, payload, retries) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'solana-degen-rent-checker/1.0',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === retries) {
          throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
        }

        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250);
        await sleep(delay);
        continue;
      }

      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(
        Math.min(30_000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250)
      );
    }
  }

  throw lastError || new Error('RPC request failed');
}

async function rpcSingle(url, method, params, retries, id) {
  assertReadOnly(method);
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
  for (const call of calls) assertReadOnly(call.method);
  const payload = calls.map((call) => ({
    jsonrpc: '2.0',
    id: call.id,
    method: call.method,
    params: call.params,
  }));

  try {
    const response = await postJson(url, payload, retries);
    if (!Array.isArray(response)) {
      throw new Error('Endpoint did not return a JSON-RPC batch array');
    }
    return new Map(response.map((item) => [String(item.id), item]));
  } catch (batchError) {
    const entries = await Promise.all(payload.map(async (call) => {
      try {
        const result = await rpcSingle(
          url,
          call.method,
          call.params,
          retries,
          call.id
        );
        return [String(call.id), { jsonrpc: '2.0', id: call.id, result }];
      } catch (error) {
        return [String(call.id), {
          jsonrpc: '2.0',
          id: call.id,
          error: { message: error.message, batch_error: batchError.message },
        }];
      }
    }));
    return new Map(entries);
  }
}

function responseError(response) {
  if (!response) return 'missing RPC response';
  if (!response.error) return null;
  return response.error.message || JSON.stringify(response.error);
}

function parseTokenAccounts(result, tokenProgram) {
  const rows = Array.isArray(result?.value) ? result.value : [];
  const accounts = [];

  for (const row of rows) {
    const info = row?.account?.data?.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    if (!info?.mint || !tokenAmount || typeof tokenAmount.amount !== 'string') {
      continue;
    }

    const rawAmount = BigInt(tokenAmount.amount);
    const decimals = Number(tokenAmount.decimals || 0);
    const lamports = BigInt(row?.account?.lamports ?? 0);
    const rawSpace = row?.account?.space ?? row?.account?.data?.space;
    const space = Number.isSafeInteger(Number(rawSpace)) && Number(rawSpace) >= 0
      ? Number(rawSpace)
      : null;

    accounts.push({
      address: row.pubkey,
      asset_type: tokenProgram === TOKEN_PROGRAM_ID ? 'SPL_TOKEN' : 'TOKEN_2022',
      token_program: tokenProgram,
      mint: info.mint,
      owner: info.owner ?? null,
      close_authority: info.closeAuthority ?? null,
      amount_raw: tokenAmount.amount,
      amount: tokenAmount.uiAmountString ?? formatUnits(rawAmount, decimals),
      decimals,
      state: info.state ?? null,
      is_native: Boolean(info.isNative),
      lamports: lamports.toString(),
      sol: formatUnits(lamports, 9),
      space,
      empty: rawAmount === 0n,
      owner_controls_close: false,
      potentially_reclaimable_empty_rent: false,
      rent_exempt_minimum_lamports: null,
      rent_exempt_minimum_sol: null,
      rent_reserve_lamports: null,
      rent_reserve_sol: null,
      excess_lamports_above_rent: null,
      excess_sol_above_rent: null,
      rent_shortfall_lamports: null,
      rent_shortfall_sol: null,
    });
  }

  return accounts;
}

function applyRentData(accounts, minimumBySpace, walletAddress) {
  for (const account of accounts) {
    account.owner_controls_close =
      account.owner === walletAddress &&
      (account.close_authority === null || account.close_authority === walletAddress);
    account.potentially_reclaimable_empty_rent =
      account.empty && account.owner_controls_close;

    if (account.space === null || !minimumBySpace.has(account.space)) continue;

    const actual = BigInt(account.lamports);
    const required = BigInt(minimumBySpace.get(account.space));
    const reserve = actual < required ? actual : required;
    const excess = actual > required ? actual - required : 0n;
    const shortfall = actual < required ? required - actual : 0n;

    account.rent_exempt_minimum_lamports = required.toString();
    account.rent_exempt_minimum_sol = formatUnits(required, 9);
    account.rent_reserve_lamports = reserve.toString();
    account.rent_reserve_sol = formatUnits(reserve, 9);
    account.excess_lamports_above_rent = excess.toString();
    account.excess_sol_above_rent = formatUnits(excess, 9);
    account.rent_shortfall_lamports = shortfall.toString();
    account.rent_shortfall_sol = formatUnits(shortfall, 9);
  }
}

function summarizeAccounts(accounts) {
  let accountLamports = 0n;
  let rentReserve = 0n;
  let reclaimableEmpty = 0n;
  let restrictedEmpty = 0n;
  let nonempty = 0n;
  let excess = 0n;
  let shortfall = 0n;
  let emptyCount = 0;
  let ownerClosableEmptyCount = 0;
  let unknownSpaceCount = 0;

  for (const account of accounts) {
    accountLamports += BigInt(account.lamports);
    if (account.empty) emptyCount += 1;
    if (account.potentially_reclaimable_empty_rent) ownerClosableEmptyCount += 1;

    if (account.rent_reserve_lamports === null) {
      unknownSpaceCount += 1;
      continue;
    }

    const rent = BigInt(account.rent_reserve_lamports);
    rentReserve += rent;
    excess += BigInt(account.excess_lamports_above_rent || '0');
    shortfall += BigInt(account.rent_shortfall_lamports || '0');

    if (account.empty && account.owner_controls_close) reclaimableEmpty += rent;
    else if (account.empty) restrictedEmpty += rent;
    else nonempty += rent;
  }

  return {
    token_account_count: accounts.length,
    empty_token_account_count: emptyCount,
    nonempty_token_account_count: accounts.length - emptyCount,
    owner_closable_empty_account_count: ownerClosableEmptyCount,
    token_account_lamports_total: accountLamports.toString(),
    token_account_sol_total: formatUnits(accountLamports, 9),
    rent_reserve_lamports: rentReserve.toString(),
    rent_reserve_sol: formatUnits(rentReserve, 9),
    reclaimable_empty_rent_lamports: reclaimableEmpty.toString(),
    reclaimable_empty_rent_sol: formatUnits(reclaimableEmpty, 9),
    restricted_empty_rent_lamports: restrictedEmpty.toString(),
    restricted_empty_rent_sol: formatUnits(restrictedEmpty, 9),
    nonempty_rent_lamports: nonempty.toString(),
    nonempty_rent_sol: formatUnits(nonempty, 9),
    excess_lamports_above_rent: excess.toString(),
    excess_sol_above_rent: formatUnits(excess, 9),
    rent_shortfall_lamports: shortfall.toString(),
    rent_shortfall_sol: formatUnits(shortfall, 9),
    unknown_space_account_count: unknownSpaceCount,
  };
}

async function scanWallets(wallets, options) {
  for (let start = 0; start < wallets.length; start += options.batchWallets) {
    const chunk = wallets.slice(start, start + options.batchWallets);
    const calls = [];

    chunk.forEach((wallet, localIndex) => {
      const key = String(start + localIndex);
      calls.push({
        id: `${key}:legacy`,
        method: 'getTokenAccountsByOwner',
        params: [
          wallet.address,
          { programId: TOKEN_PROGRAM_ID },
          { commitment: options.commitment, encoding: 'jsonParsed' },
        ],
      });
      calls.push({
        id: `${key}:token2022`,
        method: 'getTokenAccountsByOwner',
        params: [
          wallet.address,
          { programId: TOKEN_2022_PROGRAM_ID },
          { commitment: options.commitment, encoding: 'jsonParsed' },
        ],
      });
    });

    const responses = await rpcBatch(options.rpc, calls, options.retries);
    const accountsByWallet = new Map();
    const spaces = new Set();

    chunk.forEach((_wallet, localIndex) => {
      const key = String(start + localIndex);
      const legacy = responses.get(`${key}:legacy`);
      const token2022 = responses.get(`${key}:token2022`);
      const accounts = [
        ...(legacy?.result ? parseTokenAccounts(legacy.result, TOKEN_PROGRAM_ID) : []),
        ...(token2022?.result ? parseTokenAccounts(token2022.result, TOKEN_2022_PROGRAM_ID) : []),
      ];
      for (const account of accounts) {
        if (account.space !== null) spaces.add(account.space);
      }
      accountsByWallet.set(key, accounts);
    });

    const rentCalls = [...spaces].map((space) => ({
      id: `rent:${space}`,
      method: 'getMinimumBalanceForRentExemption',
      params: [space, { commitment: options.commitment }],
    }));
    const rentResponses = rentCalls.length
      ? await rpcBatch(options.rpc, rentCalls, options.retries)
      : new Map();
    const minimumBySpace = new Map();
    const sharedRentErrors = [];

    for (const space of spaces) {
      const response = rentResponses.get(`rent:${space}`);
      const error = responseError(response);
      if (error) sharedRentErrors.push(`rent minimum for ${space} bytes: ${error}`);
      else minimumBySpace.set(space, String(response.result));
    }

    chunk.forEach((wallet, localIndex) => {
      const key = String(start + localIndex);
      const errors = [...sharedRentErrors];
      for (const [label, response] of [
        ['legacy token scan', responses.get(`${key}:legacy`)],
        ['Token-2022 scan', responses.get(`${key}:token2022`)],
      ]) {
        const error = responseError(response);
        if (error) errors.push(`${label}: ${error}`);
      }

      const accounts = accountsByWallet.get(key) || [];
      applyRentData(accounts, minimumBySpace, wallet.address);
      wallet.token_accounts = accounts;
      wallet.rent_summary = summarizeAccounts(accounts);
      wallet.rpc_error = errors.length ? errors.join(' | ') : null;
    });

    console.error(
      `Rent scan: ${Math.min(start + chunk.length, wallets.length)}/${wallets.length} wallets`
    );
  }
}

function summarizeReport(wallets) {
  const fields = [
    'token_account_lamports_total',
    'rent_reserve_lamports',
    'reclaimable_empty_rent_lamports',
    'restricted_empty_rent_lamports',
    'nonempty_rent_lamports',
    'excess_lamports_above_rent',
    'rent_shortfall_lamports',
  ];
  const sums = Object.fromEntries(fields.map((field) => [field, 0n]));
  let tokenAccounts = 0;
  let emptyAccounts = 0;
  let nonemptyAccounts = 0;
  let closableEmptyAccounts = 0;
  let unknownSpaceAccounts = 0;
  let walletsWithTokenAccounts = 0;

  for (const wallet of wallets) {
    const rent = wallet.rent_summary;
    if (rent.token_account_count > 0) walletsWithTokenAccounts += 1;
    tokenAccounts += rent.token_account_count;
    emptyAccounts += rent.empty_token_account_count;
    nonemptyAccounts += rent.nonempty_token_account_count;
    closableEmptyAccounts += rent.owner_closable_empty_account_count;
    unknownSpaceAccounts += rent.unknown_space_account_count;
    for (const field of fields) sums[field] += BigInt(rent[field]);
  }

  return {
    wallet_count: wallets.length,
    wallets_with_token_accounts: walletsWithTokenAccounts,
    token_account_count: tokenAccounts,
    empty_token_account_count: emptyAccounts,
    nonempty_token_account_count: nonemptyAccounts,
    owner_closable_empty_account_count: closableEmptyAccounts,
    token_account_lamports_total: sums.token_account_lamports_total.toString(),
    token_account_sol_total: formatUnits(sums.token_account_lamports_total, 9),
    rent_reserve_lamports: sums.rent_reserve_lamports.toString(),
    rent_reserve_sol: formatUnits(sums.rent_reserve_lamports, 9),
    reclaimable_empty_rent_lamports: sums.reclaimable_empty_rent_lamports.toString(),
    reclaimable_empty_rent_sol: formatUnits(sums.reclaimable_empty_rent_lamports, 9),
    restricted_empty_rent_lamports: sums.restricted_empty_rent_lamports.toString(),
    restricted_empty_rent_sol: formatUnits(sums.restricted_empty_rent_lamports, 9),
    nonempty_rent_lamports: sums.nonempty_rent_lamports.toString(),
    nonempty_rent_sol: formatUnits(sums.nonempty_rent_lamports, 9),
    excess_lamports_above_rent: sums.excess_lamports_above_rent.toString(),
    excess_sol_above_rent: formatUnits(sums.excess_lamports_above_rent, 9),
    rent_shortfall_lamports: sums.rent_shortfall_lamports.toString(),
    rent_shortfall_sol: formatUnits(sums.rent_shortfall_lamports, 9),
    unknown_space_account_count: unknownSpaceAccounts,
  };
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(headers, rows) {
  return `${[
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(',')),
  ].join('\n')}\n`;
}

function writeOutputs(report, outputPrefix) {
  const prefix = path.resolve(outputPrefix);
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const jsonFile = `${prefix}.json`;
  const walletsFile = `${prefix}_wallets.csv`;
  const accountsFile = `${prefix}_accounts.csv`;

  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  const walletHeaders = [
    'seed_index', 'account_index', 'derivation_path', 'address',
    'token_account_count', 'empty_token_account_count',
    'nonempty_token_account_count', 'owner_closable_empty_account_count',
    'token_account_lamports_total', 'token_account_sol_total',
    'rent_reserve_lamports', 'rent_reserve_sol',
    'reclaimable_empty_rent_lamports', 'reclaimable_empty_rent_sol',
    'restricted_empty_rent_lamports', 'restricted_empty_rent_sol',
    'nonempty_rent_lamports', 'nonempty_rent_sol',
    'excess_lamports_above_rent', 'excess_sol_above_rent',
    'rent_shortfall_lamports', 'rent_shortfall_sol',
    'unknown_space_account_count', 'rpc_error',
  ];
  const walletRows = report.wallets.map((wallet) => ({
    seed_index: wallet.seed_index,
    account_index: wallet.account_index,
    derivation_path: wallet.derivation_path,
    address: wallet.address,
    ...wallet.rent_summary,
    rpc_error: wallet.rpc_error,
  }));
  fs.writeFileSync(walletsFile, csv(walletHeaders, walletRows), { mode: 0o600 });

  const accountHeaders = [
    'seed_index', 'account_index', 'derivation_path', 'owner_address',
    'token_account_address', 'asset_type', 'token_program', 'mint',
    'token_amount_raw', 'token_amount', 'decimals', 'state', 'is_native',
    'empty', 'close_authority', 'owner_controls_close',
    'potentially_reclaimable_empty_rent', 'account_lamports', 'account_sol',
    'space', 'rent_exempt_minimum_lamports', 'rent_exempt_minimum_sol',
    'rent_reserve_lamports', 'rent_reserve_sol',
    'excess_lamports_above_rent', 'excess_sol_above_rent',
    'rent_shortfall_lamports', 'rent_shortfall_sol',
  ];
  const accountRows = report.wallets.flatMap((wallet) =>
    wallet.token_accounts.map((account) => ({
      seed_index: wallet.seed_index,
      account_index: wallet.account_index,
      derivation_path: wallet.derivation_path,
      owner_address: wallet.address,
      token_account_address: account.address,
      asset_type: account.asset_type,
      token_program: account.token_program,
      mint: account.mint,
      token_amount_raw: account.amount_raw,
      token_amount: account.amount,
      decimals: account.decimals,
      state: account.state,
      is_native: account.is_native,
      empty: account.empty,
      close_authority: account.close_authority,
      owner_controls_close: account.owner_controls_close,
      potentially_reclaimable_empty_rent: account.potentially_reclaimable_empty_rent,
      account_lamports: account.lamports,
      account_sol: account.sol,
      space: account.space,
      rent_exempt_minimum_lamports: account.rent_exempt_minimum_lamports,
      rent_exempt_minimum_sol: account.rent_exempt_minimum_sol,
      rent_reserve_lamports: account.rent_reserve_lamports,
      rent_reserve_sol: account.rent_reserve_sol,
      excess_lamports_above_rent: account.excess_lamports_above_rent,
      excess_sol_above_rent: account.excess_sol_above_rent,
      rent_shortfall_lamports: account.rent_shortfall_lamports,
      rent_shortfall_sol: account.rent_shortfall_sol,
    }))
  );
  fs.writeFileSync(accountsFile, csv(accountHeaders, accountRows), { mode: 0o600 });

  return { jsonFile, walletsFile, accountsFile };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const wallets = loadWallets(options);
  console.error(`Loaded ${wallets.length} public wallet address(es)`);

  await scanWallets(wallets, options);

  const report = {
    generated_at: new Date().toISOString(),
    source_inventory: options.inventory ? path.resolve(options.inventory) : null,
    source_addresses: options.addresses ? path.resolve(options.addresses) : null,
    rpc: options.rpc,
    commitment: options.commitment,
    transaction_capability: false,
    read_only_rpc_methods: [...READ_ONLY_RPC_METHODS],
    scope:
      'Rent accounting covers legacy SPL Token and Token-2022 accounts returned by getTokenAccountsByOwner.',
    interpretation: {
      rent_reserve:
        'Current rent-exempt reserve tied up in discovered token accounts.',
      reclaimable_empty_rent:
        'Reserve in zero-balance accounts whose token owner also controls account closure. This tool does not close them.',
      restricted_empty_rent:
        'Reserve in zero-balance accounts whose close authority is not the scanned wallet.',
      nonempty_rent:
        'Reserve in token accounts that currently contain token units.',
    },
    summary: summarizeReport(wallets),
    wallets,
  };

  const files = writeOutputs(report, options.output);

  console.log(`Total token-account rent reserve: ${report.summary.rent_reserve_sol} SOL`);
  console.log(
    `Potentially reclaimable empty-account rent: ` +
    `${report.summary.reclaimable_empty_rent_sol} SOL`
  );
  console.log(`Restricted empty-account rent: ${report.summary.restricted_empty_rent_sol} SOL`);
  console.log(`Rent attached to nonempty accounts: ${report.summary.nonempty_rent_sol} SOL`);
  console.log(`JSON: ${files.jsonFile}`);
  console.log(`Wallet CSV: ${files.walletsFile}`);
  console.log(`Account CSV: ${files.accountsFile}`);
}

main().catch((error) => {
  console.error(`Fatal: ${error.stack || error.message}`);
  process.exitCode = 1;
});
