# Program upgrades (Devnet)

Program `4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL`. Today the upgrade
authority is the devnet deployer key; after [multisig.md](multisig.md) it
is the Squads vault and every upgrade is a multisig proposal.

## Before

1. `pnpm verify` passes on the commit you deploy.
2. Deployer has ≥ 6 SOL: the upload buffer needs ≈ 4.35 SOL (refunded by
   the upgrade). Faucet: `solana airdrop 1 <pk> --url https://rpc.magicblock.app/devnet`
   (rate-limited; a few per hour).
3. Pick the build:
   - `pnpm deploy:devnet` builds the **test-deck variant**
     (`poc-test-deck`, needed by the privacy suite and handflow probes).
   - A **public Devnet release must not contain the test deck**: build with
     `anchor build` (default) and deploy that `.so` (P9 adds a release
     script for this).
4. If the account layout changed, existing tables won't decode: plan to
   close them first (players cash out).

## Deploy

```bash
pnpm deploy:devnet      # resumable buffer upload, extends space if needed,
                        # upgrades, then checks the on-chain bytes
```

On a network failure just rerun it; it resumes the buffer. If you give up,
close the buffer to get the SOL back: `solana program show --buffers`,
`solana program close <buffer>`.

## After

1. `pnpm --filter @card-flex/client-sdk sync-idl` if instructions changed;
   commit the IDL.
2. Run on Devnet: `pnpm privacy-suite -- --region <label>` (G1) and
   `pnpm money -- --region <label>`; for game changes also `pnpm handflow`
   and `pnpm game`.
3. Restart the keeper if its code changed.

## With the multisig

Upload the buffer with the deployer as before (`solana program
write-buffer`), set the buffer authority to the Squads vault
(`solana program set-buffer-authority <buffer> --new-buffer-authority
<vault>`), then propose "upgrade program from buffer" in Squads. Members
approve; the vault executes.
