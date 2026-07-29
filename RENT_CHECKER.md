# Token-Account Rent Checker

`rent_checker.cjs` measures how much SOL is currently tied up as rent-exempt
reserve across the legacy SPL Token and Token-2022 accounts owned by the
wallets found by the main scanner.

It is read-only. It does not construct, sign, simulate, or submit transactions.
It also does not need seed phrases: it reads the public addresses from the
inventory JSON produced by `solana_inventory.cjs`.

## Run after the wallet scan

```bash
export SOLANA_RPC_URL='https://your-solana-rpc.example'

node solana_inventory.cjs \
  --seeds ./seedphrases.txt \
  --count 200 \
  --output ./inventory

node rent_checker.cjs \
  --inventory ./inventory.json \
  --output ./inventory_rent
```

It can also read a file containing one public address per line:

```bash
node rent_checker.cjs \
  --addresses ./addresses.txt \
  --output ./rent_report
```

## Reported values

- `rent_reserve_sol`: total current rent-exempt reserve in discovered token accounts.
- `reclaimable_empty_rent_sol`: reserve in zero-balance token accounts whose token owner also controls account closure.
- `restricted_empty_rent_sol`: reserve in empty token accounts whose close authority is another address.
- `nonempty_rent_sol`: reserve in token accounts that currently contain token units.
- `excess_sol_above_rent`: account lamports above the calculated rent-exempt minimum.
- `rent_shortfall_sol`: any difference where an account contains fewer lamports than the current calculated minimum.

The checker reads each account's actual data size and calls
`getMinimumBalanceForRentExemption` for every observed size. This matters for
Token-2022 accounts because extensions can make them larger than the legacy
165-byte token-account layout.

“Potentially reclaimable” is informational. This tool does not close accounts,
move tokens, or prepare transactions.

## Outputs

For `--output ./inventory_rent`:

```text
inventory_rent.json
inventory_rent_wallets.csv
inventory_rent_accounts.csv
```

The JSON contains an aggregate summary and account-level records. The wallet
CSV gives one row per scanned wallet. The account CSV shows each token
account's mint, close authority, data size, current lamports, calculated rent
minimum, and recoverability classification.

## Read-only RPC allowlist

```text
getTokenAccountsByOwner
getMinimumBalanceForRentExemption
```
