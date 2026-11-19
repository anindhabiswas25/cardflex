# Handing control to a Squads multisig

Two keys control the program today, both the devnet deployer
(`Cf3ux3ZqSfYutZyxLeEWLeNkpUkPBMneyU3VUwEUww8x`):

1. the **upgrade authority** (can replace the program: the worst-case key);
2. **`GlobalConfig.authority`** (treasury, max rake, pause).

After this runbook both are a Squads multisig vault. Since CF-055 the second
follows the first via `sync_global_authority`.

## Decide first (team)

- Members (one key per person, hardware wallets preferred) and threshold
  (e.g. 2 of 3). Losing threshold-many keys means the program can never be
  upgraded again.
- Optional time lock for upgrades.

## Steps

1. **Create the multisig** in the Squads app (Devnet), add members and
   threshold. Note the **vault address** (the "default vault", index 0), not
   the multisig account address.
2. **Fund the vault** with a little SOL for fees.
3. **Move the upgrade authority** (deployer signs; check the vault address
   twice, this can't be undone by us):

   ```bash
   solana program set-upgrade-authority 4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL \
     --new-upgrade-authority <VAULT> --skip-new-upgrade-authority-signer-check \
     --keypair ~/.config/cardflex/devnet-deployer.json --url https://api.devnet.solana.com
   solana program show 4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL --url https://api.devnet.solana.com   # Authority = VAULT
   ```

4. **Move the settings authority:** build the instruction for the vault and
   propose it in Squads (custom transaction):

   ```bash
   cf-admin global sync-authority --dry-run --as <VAULT>
   ```

   It prints the program id, accounts and data (base64). Members approve; the
   vault executes. Check: `cf-admin global show` → authority = VAULT.
5. **Later settings changes** (pause, treasury, max rake): build with
   `cf-admin global set … --dry-run --as <VAULT>` and propose the same way.
6. Update AGENTS.md (upgrade authority) and remove the deployer key from
   anything that relied on it for upgrades.

## Undo

Only the multisig can move control back: propose `set-upgrade-authority`
from the vault to another key, then `sync_global_authority` signed by that
key.
