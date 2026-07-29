# Solana Read-Only Inventory Scanner

This tool reads a text file containing one mnemonic per line, derives **200 Solana addresses per mnemonic by default**, and inventories their assets without constructing, signing, simulating, or submitting any transaction.

“Subaccounts” here means deterministic derived wallet addresses. Creating an on-chain account would require a transaction, so this scanner only derives the addresses locally.

## Inventory coverage

Standard Solana RPC scanning identifies:

- Native SOL balances
- Legacy SPL Token accounts
- Token-2022 accounts
- Every nonzero token account, aggregated by mint and token program

An optional DAS-compatible endpoint can additionally identify indexed assets such as:

- NFTs and programmable NFTs
- Compressed NFTs
- Fungible-token names and symbols
- Token-2022 metadata
- Inscriptions
- Collections and metadata URIs

Compressed NFTs are not ordinary token accounts, so standard RPC alone cannot discover them.

## Read-only boundary

The scanner:

- has no runtime package dependencies
- uses only Node.js built-in cryptography, filesystem, and HTTP support
- imports no Solana transaction or instruction SDK
- creates no transaction, instruction, signer, or wallet-adapter object
- restricts RPC calls to an explicit allowlist:
  - `getBalance`
  - `getTokenAccountsByOwner`
  - `getAssetsByOwner`
- never writes mnemonic phrases, BIP-39 seeds, derived private seeds, or secret keys to output

The rent checker is also read-only. It restricts RPC calls to:

- `getTokenAccountsByOwner`
- `getMinimumBalanceForRentExemption`

Neither tool closes accounts or constructs, signs, simulates, or submits transactions.

## Requirements

Node.js 18 or newer.

```bash
npm run check
```

No `npm install` is required.

## Seed file

Copy the example and replace its commented example with your phrases:

```bash
cp seedphrases.example.txt seedphrases.txt
chmod 600 seedphrases.txt
```

Use one phrase per line:

```text
word1 word2 word3 ... word12
word1 word2 word3 ... word24
```

Blank lines and lines beginning with `#` are ignored. Accepted word counts are 12, 15, 18, 21, and 24. The scanner performs BIP-39 PBKDF2 seed derivation directly and derives exactly the phrase supplied; it does not bundle a language-specific wordlist or checksum validator.

## Basic scan

```bash
export SOLANA_RPC_URL='https://your-mainnet-rpc.example'

node solana_inventory.cjs \
  --seeds ./seedphrases.txt \
  --count 200 \
  --output ./inventory
```

The default derivation path is:

```text
m/44'/501'/{index}'/0'
```

The `{index}` marker is replaced with `0` through `199` by default.

## Different derivation convention

```bash
node solana_inventory.cjs \
  --seeds ./seedphrases.txt \
  --path-template "m/44'/501'/{index}'" \
  --count 200 \
  --output ./inventory_account_path
```

Use `--start` to scan a later account-index range.

## Full scan with DAS indexing

Set both the normal Solana RPC endpoint and a DAS-compatible endpoint:

```bash
export SOLANA_RPC_URL='https://your-standard-solana-rpc.example'
export SOLANA_DAS_RPC_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'

node solana_inventory.cjs \
  --seeds ./seedphrases.txt \
  --count 200 \
  --output ./inventory
```

The same endpoint can also be passed explicitly with `--das-rpc`.

## Optional BIP-39 passphrase

A single BIP-39 passphrase can be applied to every mnemonic:

```bash
export BIP39_PASSPHRASE='your passphrase'
node solana_inventory.cjs --seeds ./seedphrases.txt
```

## Check token-account rent

Run the rent checker against the inventory produced by the main scanner:

```bash
node rent_checker.cjs \
  --inventory ./inventory.json \
  --output ./inventory_rent
```

The equivalent npm command is:

```bash
npm run rent -- \
  --inventory ./inventory.json \
  --output ./inventory_rent
```

The rent checker scans legacy SPL Token and Token-2022 accounts and calculates the rent-exempt minimum from each account's actual data size. It reports, per wallet and in aggregate:

- total lamports held in token accounts
- rent-exempt reserve tied up in those accounts
- empty-account rent potentially recoverable by the wallet owner
- empty-account rent controlled by an external close authority
- rent tied to token accounts that still hold assets
- lamports held above the rent-exempt minimum
- any detected rent shortfall

It can also scan a public-address list without requiring an inventory file:

```bash
node rent_checker.cjs \
  --addresses ./addresses.txt \
  --output ./address_rent
```

See [`RENT_CHECKER.md`](./RENT_CHECKER.md) for the rent-field definitions and complete command reference.

## Outputs

For `--output ./inventory`, the scanner writes:

- `inventory.json` — complete structured report
- `inventory_wallets.csv` — one row per derived address
- `inventory_assets.csv` — native SOL and raw SPL/Token-2022 holdings
- `inventory_das_assets.csv` — DAS-normalized assets when DAS is configured

For `--output ./inventory_rent`, the rent checker writes:

- `inventory_rent.json` — aggregate, wallet, and token-account rent details
- `inventory_rent_wallets.csv` — one rent summary row per derived wallet
- `inventory_rent_accounts.csv` — one row per legacy SPL or Token-2022 account

Output files are created with mode `0600` on Unix-like systems.

## Useful options

Inventory scanner:

```text
--count 200
--start 0
--batch-size 10
--commitment finalized
--retries 5
--include-zero
--das-concurrency 4
--das-page-size 1000
```

Rent checker:

```text
--inventory ./inventory.json
--addresses ./addresses.txt
--output ./rent_report
--batch-wallets 10
--commitment finalized
--retries 5
```

Run `node solana_inventory.cjs --help` or `node rent_checker.cjs --help` for the full CLI references.

## Scope limitation

Standard RPC mode reports assets directly owned by each derived address. It does not infer assets deposited into DeFi protocols, stake accounts controlled through separate authorities, escrowed positions, or compressed NFTs. DAS expands indexed asset identification but remains dependent on the configured provider’s index.

The rent checker currently inventories rent held by legacy SPL Token and Token-2022 accounts owned by the scanned addresses. It does not include every possible Solana account type, such as stake accounts, nonce accounts, program-derived escrow accounts, or arbitrary program state.