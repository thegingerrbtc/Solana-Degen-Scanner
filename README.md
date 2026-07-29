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

## Outputs

For `--output ./inventory`, the scanner writes:

- `inventory.json` — complete structured report
- `inventory_wallets.csv` — one row per derived address
- `inventory_assets.csv` — native SOL and raw SPL/Token-2022 holdings
- `inventory_das_assets.csv` — DAS-normalized assets when DAS is configured

Output files are created with mode `0600` on Unix-like systems.

## Useful options

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

Run `node solana_inventory.cjs --help` for the full CLI reference.

## Scope limitation

Standard RPC mode reports assets directly owned by each derived address. It does not infer assets deposited into DeFi protocols, stake accounts controlled through separate authorities, escrowed positions, or compressed NFTs. DAS expands indexed asset identification but remains dependent on the configured provider’s index.
