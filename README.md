# Solana Read-Only Inventory Scanner

This tool reads a text file containing one BIP-39 mnemonic per line, derives **200 addresses per mnemonic by default**, and inventories assets without constructing, signing, simulating, or submitting any transaction.

“Subaccounts” here are deterministic derived wallet addresses. Creating an on-chain account would require a transaction, so this tool does not do that.

## What it inventories

### Standard RPC mode

- Native SOL balance
- Legacy SPL Token accounts
- Token-2022 accounts
- Every nonzero token account, aggregated by mint and token program

### Optional DAS mode

With a DAS-compatible endpoint such as Helius, it can also identify:

- NFTs and programmable NFTs
- Compressed NFTs
- Fungible tokens with names and symbols
- Token-2022 assets
- Inscriptions
- Collection and metadata fields exposed by the provider

Standard RPC cannot discover compressed NFTs because they are not ordinary token accounts. Use `--mode both` for the raw on-chain balances plus DAS asset indexing.

## Read-only boundary

The script:

- has no runtime package dependencies
- uses only Node.js built-in cryptography and HTTP support
- imports no Solana transaction or instruction SDK
- creates no `Transaction`, signer, or wallet-adapter object
- has an explicit RPC allowlist containing only:
  - `getBalance`
  - `getTokenAccountsByOwner`
  - `getAssetsByOwner`
- never writes mnemonic phrases, BIP-39 seeds, derived private seeds, or secret keys to output

## Install

Node.js 18 or newer is required.

```bash
npm run check
```

No `npm install` is required.

## Seed file

Create `seedphrases.txt` with one mnemonic per line:

```text
word1 word2 word3 ... word12
word1 word2 word3 ... word24
```

Blank lines and lines beginning with `#` are ignored. Standard BIP-39 word counts are 12, 15, 18, 21, and 24. The scanner performs the BIP-39 PBKDF2 seed derivation directly; it does not need a language-specific wordlist package.

On Linux:

```bash
chmod 600 seedphrases.txt
```

## Basic scan

```bash
export SOLANA_RPC_URL='https://your-mainnet-rpc.example'
node solana_inventory.cjs \
  --seeds ./seedphrases.txt \
  --count 200 \
  --output ./inventory
```

The default path is:

```text
m/44'/501'/{index}'/0'
```

This is the common Solana wallet account-index pattern used by several wallet implementations.

## Scan a different derivation convention

```bash
node solana_inventory.cjs \
  --seeds ./seedphrases.txt \
  --path-template "m/44'/501'/{index}'" \
  --count 200 \
  --output ./inventory_account_path
```

The `{index}` marker is replaced with `0` through `199`, or with the range selected using `--start` and `--count`.

## Full asset scan with DAS

Set a DAS-compatible endpoint separately:

```bash
export SOLANA_RPC_URL='https://your-standard-solana-rpc.example'
export SOLANA_DAS_RPC_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'

node solana_inventory.cjs \
  --seeds ./seedphrases.txt \
  --mode both \
  --count 200 \
  --output ./inventory
```

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
- `inventory_das_assets.csv` — DAS-normalized assets when DAS mode is enabled

Output files are created with mode `0600` on Unix-like systems.

## Useful options

```text
--count 200
--start 0
--batch-wallets 10
--commitment finalized
--retries 5
--include-zero
--allow-nonstandard
--mode rpc
--mode das
--mode both
--das-concurrency 4
--das-page-size 1000
```

Run `node solana_inventory.cjs --help` for the complete CLI reference.

## Scope limitation

Raw RPC mode reports assets directly owned by each derived address: SOL, legacy SPL Token accounts, and Token-2022 accounts. It does not infer assets deposited into DeFi protocols, stake accounts controlled through separate authorities, escrowed positions, or compressed NFTs. DAS mode expands NFT/cNFT/token identification but remains dependent on the provider's index.
