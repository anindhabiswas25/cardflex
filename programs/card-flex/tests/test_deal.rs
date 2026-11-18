//! CF-011: the real deal path, run in LiteSVM with hand-built accounts (the
//! ephemeral accounts normally live in PER). Checks correctness against the
//! host `fairness-core` and measures compute units.

use {
    anchor_lang::{
        prelude::Pubkey, solana_program::instruction::Instruction, AccountDeserialize,
        AccountSerialize, InstructionData, Space, ToAccountMetas,
    },
    card_flex::table::*,
    fairness_core::{SoftSha256, TREE_DEPTH},
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

fn svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/card_flex.so"
    ));
    svm.add_program(card_flex::id(), bytes).unwrap();
    svm
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], signer: &Keypair) -> Result<u64, String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
    svm.send_transaction(tx)
        .map(|m| m.compute_units_consumed)
        .map_err(|e| format!("{:?}", e.err))
}

fn program_account(data: Vec<u8>) -> Account {
    Account {
        lamports: 10_000_000,
        data,
        owner: card_flex::id(),
        executable: false,
        rent_epoch: 0,
    }
}

fn cu_ix(units: u32) -> Instruction {
    // ComputeBudgetInstruction::SetComputeUnitLimit (discriminant 2, u32 LE).
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(
        "ComputeBudget111111111111111111111111111111"
            .parse()
            .unwrap(),
        &data,
        vec![],
    )
}

#[test]
fn bench_deal_compute_units() {
    let mut svm = svm();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let mut report = Vec::new();
    for seats in 2..=6u8 {
        let ix = Instruction::new_with_bytes(
            card_flex::id(),
            &card_flex::instruction::BenchDeal {
                hand_ctx: [7; 32],
                seed: [9; 32],
                seats,
            }
            .data(),
            card_flex::accounts::BenchDeal {}.to_account_metas(None),
        );
        let cu = send(&mut svm, &[cu_ix(1_400_000), ix], &payer).expect("bench runs");
        report.push((seats, cu));
    }
    eprintln!("bench_deal compute units (seats, CU): {report:?}");
    // Must leave ample room under the 200k default per-instruction budget.
    assert!(report.iter().all(|&(_, cu)| cu < 200_000), "{report:?}");
}

struct Table {
    svm: LiteSVM,
    payer: Keypair,
    runtime: Pubkey,
    dealer: Pubkey,
    hands: Vec<Pubkey>,
    hand_ctx: [u8; 32],
    seed: [u8; 32],
}

/// A seeded table: runtime in phase SEEDED, dealer holding the seed, empty
/// seat hands, all owned by the program as they would be inside PER.
fn seeded_table(seats: u8) -> Table {
    let mut svm = svm();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let config = Pubkey::new_unique();
    let (runtime, bump) =
        Pubkey::find_program_address(&[RUNTIME_SEED, config.as_ref()], &card_flex::id());
    let (dealer, _) =
        Pubkey::find_program_address(&[DEALER_SEED, runtime.as_ref()], &card_flex::id());
    let hand_ctx = [0x3c; 32];
    let seed = [0x5e; 32];

    let mut rt = TableRuntime {
        config,
        authority: Pubkey::new_unique(),
        max_seats: 6,
        occupied: (1u8 << seats) - 1,
        wallets: [Pubkey::default(); MAX_SEATS],
        session_keys: [Pubkey::default(); MAX_SEATS],
        hand_no: 3,
        dealt: false,
        locked: true,
        grants: 0,
        phase: phase::SEEDED,
        hand_ctx,
        roster_hash: [0; 32],
        salts_in: (1u8 << seats) - 1,
        dealing_order: [0; MAX_SEATS],
        dealing_count: seats,
        salt_commitments: [[0; 32]; MAX_SEATS],
        vrf_caller_seed: [0; 32],
        merkle_root: [0; 32],
        vrf_request_slot: 0,
        cancelled_hands: 0,
        stacks: [0; MAX_SEATS],
        commit_seq: 0,
        bump,
    };
    for s in 0..seats as usize {
        rt.dealing_order[s] = s as u8;
    }
    let mut rt_data = Vec::new();
    rt.try_serialize(&mut rt_data).unwrap();
    rt_data.resize(8 + TableRuntime::INIT_SPACE, 0);
    svm.set_account(runtime, program_account(rt_data)).unwrap();

    let mut d = vec![0u8; DEALER_LEN as usize];
    d[..8].copy_from_slice(DEALER_TAG);
    d[8..40].copy_from_slice(runtime.as_ref());
    d[40..48].copy_from_slice(&3u64.to_le_bytes());
    d[DEALER_SEED_OFFSET..DEALER_SEED_OFFSET + 32].copy_from_slice(&seed);
    svm.set_account(dealer, program_account(d)).unwrap();

    let hands: Vec<Pubkey> = (0..seats)
        .map(|s| {
            let (h, _) = Pubkey::find_program_address(
                &[SEAT_HAND_SEED, runtime.as_ref(), &[s]],
                &card_flex::id(),
            );
            let mut data = vec![0u8; SEAT_HAND_LEN as usize];
            data[..8].copy_from_slice(SEAT_HAND_TAG);
            data[8..40].copy_from_slice(runtime.as_ref());
            data[40] = s;
            svm.set_account(h, program_account(data)).unwrap();
            h
        })
        .collect();
    Table {
        svm,
        payer,
        runtime,
        dealer,
        hands,
        hand_ctx,
        seed,
    }
}

fn deal_ix(t: &Table, hands: &[Pubkey]) -> Instruction {
    let mut metas = card_flex::accounts::DealHand {
        payer: t.payer.pubkey(),
        runtime: t.runtime,
        dealer: t.dealer,
    }
    .to_account_metas(None);
    metas.extend(
        hands
            .iter()
            .map(|h| anchor_lang::solana_program::instruction::AccountMeta::new(*h, false)),
    );
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::DealHand {}.data(),
        metas,
    )
}

#[test]
fn deal_hand_matches_spec_and_every_proof_verifies() {
    for seats in [2u8, 3, 6] {
        let mut t = seeded_table(seats);
        let ix = deal_ix(&t, &t.hands.clone());
        let cu = send(&mut t.svm, &[cu_ix(1_400_000), ix], &t.payer).expect("deal_hand runs");
        eprintln!("deal_hand with {seats} seats: {cu} CU");

        let rt = TableRuntime::try_deserialize(
            &mut t.svm.get_account(&t.runtime).unwrap().data.as_slice(),
        )
        .unwrap();
        assert_eq!((rt.phase, rt.dealt), (phase::DEALT, true));

        // Host reference (software SHA-256), independent of the program build.
        let (deck, _) = fairness_core::shuffle::<SoftSha256>(&t.seed);
        let lv = fairness_core::leaves::<SoftSha256>(&t.hand_ctx, &t.seed, &deck);
        let root = fairness_core::merkle_root::<SoftSha256>(&lv);
        assert_eq!(rt.merkle_root, root, "public root");

        let dealer = t.svm.get_account(&t.dealer).unwrap().data;
        assert_eq!(
            &dealer[48..100],
            deck.map(|c| c.id()).as_slice(),
            "deck in DealerState"
        );

        let mut seen = std::collections::BTreeSet::new();
        for (k, h) in t.hands.iter().enumerate() {
            let d = t.svm.get_account(h).unwrap().data;
            for (j, pos) in fairness_core::deal_positions(k, seats as usize)
                .into_iter()
                .enumerate()
            {
                let card = card_types::Card::from_id(d[HAND_CARDS + j]).unwrap();
                assert_eq!(card, deck[pos]);
                assert_eq!(d[HAND_POSITIONS + j] as usize, pos);
                let salt: [u8; 32] = d[HAND_LEAF_SALTS + 32 * j..HAND_LEAF_SALTS + 32 * (j + 1)]
                    .try_into()
                    .unwrap();
                let proof: [[u8; 32]; TREE_DEPTH] = core::array::from_fn(|l| {
                    let at = HAND_PROOFS + (6 * j + l) * 32;
                    d[at..at + 32].try_into().unwrap()
                });
                // What a player's client does with its own SeatHand.
                assert!(fairness_core::verify_card::<SoftSha256>(
                    &rt.merkle_root,
                    &t.hand_ctx,
                    pos as u8,
                    card,
                    &salt,
                    &proof
                ));
                assert!(seen.insert(card.id()));
            }
        }
        assert_eq!(seen.len(), seats as usize * 3);
    }
}

#[test]
fn deal_hand_rejects_misuse() {
    let mut t = seeded_table(3);
    let hands = t.hands.clone();
    let payer = t.payer.insecure_clone();
    let short = deal_ix(&t, &hands[..2]);
    let swapped = deal_ix(&t, &[hands[1], hands[0], hands[2]]);
    let foreign = deal_ix(&t, &[hands[0], hands[1], Pubkey::new_unique()]);
    let good = deal_ix(&t, &hands);
    // Wrong number of hands, wrong order, wrong account.
    assert!(send(&mut t.svm, &[short], &payer).is_err());
    assert!(send(&mut t.svm, &[swapped], &payer).is_err());
    assert!(send(&mut t.svm, &[foreign], &payer).is_err());
    // Real deal, then a second deal must fail (phase is DEALT).
    assert!(send(&mut t.svm, &[cu_ix(1_400_000), good.clone()], &payer).is_ok());
    assert!(send(&mut t.svm, &[cu_ix(1_400_000), good], &payer).is_err());
}

fn set_phase(t: &mut Table, phase_value: u8, request_slot: u64) {
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    let mut rt = TableRuntime::try_deserialize(&mut acc.data.as_slice()).unwrap();
    rt.phase = phase_value;
    rt.vrf_request_slot = request_slot;
    let mut data = Vec::new();
    rt.try_serialize(&mut data).unwrap();
    data.resize(acc.data.len(), 0);
    acc.data = data;
    t.svm.set_account(t.runtime, acc).unwrap();
}

fn custom_error(res: &Result<u64, String>, err: card_flex::CardFlexError) -> bool {
    let code = err as u32 + 6000;
    matches!(res, Err(e) if e.contains(&format!("Custom({code})")))
}

fn cancel_ix(t: &Table) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::CancelHand {}.data(),
        card_flex::accounts::CancelHand {
            payer: t.payer.pubkey(),
            runtime: t.runtime,
        }
        .to_account_metas(None),
    )
}

#[test]
fn cancel_hand_only_after_vrf_timeout() {
    let mut t = seeded_table(3);
    let payer = t.payer.insecure_clone();
    // Not waiting for VRF: refused.
    let ix = cancel_ix(&t);
    assert!(custom_error(
        &send(&mut t.svm, &[ix], &payer),
        card_flex::CardFlexError::WrongPhase
    ));
    // Waiting, but too early.
    t.svm.warp_to_slot(10);
    set_phase(&mut t, phase::VRF_PENDING, 10);
    let ix = cancel_ix(&t);
    assert!(custom_error(
        &send(&mut t.svm, &[ix], &payer),
        card_flex::CardFlexError::TooEarly
    ));
    // After the timeout: cancelled, counted, hand number moves on.
    t.svm.warp_to_slot(10 + VRF_TIMEOUT_SLOTS);
    let ix = cancel_ix(&t);
    assert!(send(&mut t.svm, &[ix], &payer).is_ok());
    let rt =
        TableRuntime::try_deserialize(&mut t.svm.get_account(&t.runtime).unwrap().data.as_slice())
            .unwrap();
    assert_eq!(
        (rt.phase, rt.hand_no, rt.cancelled_hands, rt.salts_in),
        (phase::IDLE, 4, 1, 0)
    );
}

#[test]
fn ephemeral_accounts_frozen_while_a_hand_is_in_progress() {
    use anchor_lang::solana_program::instruction::AccountMeta;
    let mut t = seeded_table(3);
    let payer = t.payer.insecure_clone();
    for p in [
        phase::SALTS_PENDING,
        phase::SALTS_DONE,
        phase::VRF_PENDING,
        phase::SEEDED,
        phase::DEALT,
        phase::HAND_COMPLETE,
    ] {
        set_phase(&mut t, p, 0);
        let rt = TableRuntime::try_deserialize(
            &mut t.svm.get_account(&t.runtime).unwrap().data.as_slice(),
        )
        .unwrap();
        // TablePer layout: authority, runtime, target, permission, permission program, vault, magic.
        let mut authority_rt = rt;
        authority_rt.authority = payer.pubkey();
        let mut acc = t.svm.get_account(&t.runtime).unwrap();
        let mut data = Vec::new();
        authority_rt.try_serialize(&mut data).unwrap();
        data.resize(acc.data.len(), 0);
        acc.data = data;
        t.svm.set_account(t.runtime, acc).unwrap();
        let salt =
            Pubkey::find_program_address(&[SALT_SEED, t.runtime.as_ref(), &[0]], &card_flex::id())
                .0;
        let perm = Pubkey::find_program_address(
            &[b"permission:", salt.as_ref()],
            &ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID,
        )
        .0;
        let metas = vec![
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new(t.runtime, false),
            AccountMeta::new(salt, false),
            AccountMeta::new(perm, false),
            AccountMeta::new_readonly(ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID, false),
            AccountMeta::new(ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID, false),
            AccountMeta::new_readonly(ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID, false),
        ];
        for data in [
            card_flex::instruction::CloseSalt { seat: 0 }.data(),
            card_flex::instruction::OpenSalt { seat: 0 }.data(),
        ] {
            let ix = Instruction::new_with_bytes(card_flex::id(), &data, metas.clone());
            let res = send(&mut t.svm, &[ix], &payer);
            assert!(
                custom_error(&res, card_flex::CardFlexError::HandInProgress),
                "phase {p}: {res:?}"
            );
        }
    }
}

/// A table whose hand_ctx, roster, salts and commitments are all consistent,
/// so the revealed HandLog can be checked by the independent verifier.
#[test]
fn revealed_hand_log_passes_the_independent_verifier() {
    use fairness_core::{hand_ctx, roster_hash, salt_commitment, HandContext, Seat};
    let seats = 4u8;
    let mut t = seeded_table(seats);
    let payer = t.payer.insecure_clone();
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    let mut rt = TableRuntime::try_deserialize(&mut acc.data.as_slice()).unwrap();
    let wallets: Vec<Pubkey> = (0..seats).map(|_| Pubkey::new_unique()).collect();
    for (s, w) in wallets.iter().enumerate() {
        rt.wallets[s] = *w;
    }
    let roster = roster_hash::<SoftSha256>(
        &(0..seats)
            .map(|s| Seat {
                index: s,
                wallet: wallets[s as usize].to_bytes(),
            })
            .collect::<Vec<_>>(),
    );
    let ctx = hand_ctx::<SoftSha256>(&HandContext {
        program_id: card_flex::id().to_bytes(),
        table: rt.config.to_bytes(),
        hand_no: rt.hand_no,
        roster_hash: roster,
        rules_version: RULES_VERSION,
    });
    rt.hand_ctx = ctx;
    rt.roster_hash = roster;
    let salts: Vec<[u8; 32]> = (0..seats).map(|s| [0x70 + s; 32]).collect();
    let mut salt_accs = Vec::new();
    for s in 0..seats {
        rt.salt_commitments[s as usize] =
            salt_commitment::<SoftSha256>(&ctx, s, &salts[s as usize]);
        let (a, _) =
            Pubkey::find_program_address(&[SALT_SEED, t.runtime.as_ref(), &[s]], &card_flex::id());
        let mut d = vec![0u8; SALT_LEN as usize];
        d[..8].copy_from_slice(SALT_TAG);
        d[8..40].copy_from_slice(t.runtime.as_ref());
        d[40] = s;
        d[41..49].copy_from_slice(&rt.hand_no.to_le_bytes());
        d[49..81].copy_from_slice(&salts[s as usize]);
        t.svm.set_account(a, program_account(d)).unwrap();
        salt_accs.push(a);
    }
    let commitments: Vec<[u8; 32]> = (0..seats as usize)
        .map(|s| rt.salt_commitments[s])
        .collect();
    rt.vrf_caller_seed = fairness_core::vrf_caller_seed::<SoftSha256>(&ctx, &commitments);
    let vrf = [0x99u8; 32];
    let seed = fairness_core::shuffle_seed::<SoftSha256>(&ctx, &vrf, &salts);
    let mut data = Vec::new();
    rt.try_serialize(&mut data).unwrap();
    data.resize(acc.data.len(), 0);
    acc.data = data;
    t.svm.set_account(t.runtime, acc).unwrap();
    // Dealer holds the VRF output and the seed derived from it (as vrf_deal writes).
    let mut d = t.svm.get_account(&t.dealer).unwrap();
    d.data[DEALER_VRF_OFFSET..DEALER_VRF_OFFSET + 32].copy_from_slice(&vrf);
    d.data[DEALER_SEED_OFFSET..DEALER_SEED_OFFSET + 32].copy_from_slice(&seed);
    t.svm.set_account(t.dealer, d).unwrap();
    // HandLog as create_table leaves it.
    let (hand_log, bump) =
        Pubkey::find_program_address(&[HAND_LOG_SEED, t.runtime.as_ref()], &card_flex::id());
    let log = HandLog {
        runtime: t.runtime,
        config: rt.config,
        hand_no: 0,
        rules_version: 0,
        protocol_version: 0,
        dealing_count: 0,
        seats: [0; MAX_SEATS],
        wallets: [Pubkey::default(); MAX_SEATS],
        salts: [[0; 32]; MAX_SEATS],
        salt_commitments: [[0; 32]; MAX_SEATS],
        hand_ctx: [0; 32],
        roster_hash: [0; 32],
        vrf_caller_seed: [0; 32],
        vrf_output: [0; 32],
        merkle_root: [0; 32],
        revealed: false,
        bump,
    };
    let mut ld = Vec::new();
    log.try_serialize(&mut ld).unwrap();
    ld.resize(8 + HandLog::INIT_SPACE, 0);
    t.svm.set_account(hand_log, program_account(ld)).unwrap();

    let deal = deal_ix(&t, &t.hands.clone());
    send(&mut t.svm, &[cu_ix(1_400_000), deal], &payer).expect("deal");
    let mut metas = card_flex::accounts::RevealHand {
        payer: payer.pubkey(),
        runtime: t.runtime,
        dealer: t.dealer,
        hand_log,
    }
    .to_account_metas(None);
    metas.extend(
        salt_accs.iter().map(|a| {
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*a, false)
        }),
    );
    let reveal = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::RevealHand {}.data(),
        metas.clone(),
    );
    // Security review: no reveal while the hand is being played.
    assert!(custom_error(
        &send(&mut t.svm, std::slice::from_ref(&reveal), &payer),
        card_flex::CardFlexError::WrongPhase
    ));
    // Finish the hand (interim end_hand; P5: showdown), then reveal.
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    let mut rt2 = TableRuntime::try_deserialize(&mut acc.data.as_slice()).unwrap();
    rt2.phase = phase::HAND_COMPLETE;
    let mut data = Vec::new();
    rt2.try_serialize(&mut data).unwrap();
    data.resize(acc.data.len(), 0);
    acc.data = data;
    t.svm.set_account(t.runtime, acc).unwrap();
    send(&mut t.svm, &[reveal], &payer).expect("reveal");
    // Reveal only once.
    let again = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::RevealHand {}.data(),
        metas,
    );
    assert!(send(&mut t.svm, &[again], &payer).is_err());

    let log = HandLog::try_deserialize(&mut t.svm.get_account(&hand_log).unwrap().data.as_slice())
        .unwrap();
    assert!(log.revealed);
    // Build the public record exactly as an outside verifier would, and check it.
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let n = log.dealing_count as usize;
    let player_cards: Vec<u8> = {
        let d = t.svm.get_account(&t.hands[1]).unwrap().data;
        d[HAND_CARDS..HAND_CARDS + 3].to_vec()
    };
    let json = format!(
        r#"{{"format":"cf-hand-record/1","protocol_version":{},"program_id":"{}","table":"{}","hand_no":"{}","rules_version":{},
           "seats":[{}],"salts":[{}],"vrf_output":"{}",
           "claimed":{{"roster_hash":"{}","hand_ctx":"{}","salt_commitments":[{}],"vrf_caller_seed":"{}","merkle_root":"{}"}},
           "hands":[{{"seat":1,"cards":{:?}}}]}}"#,
        log.protocol_version,
        card_flex::id(),
        log.config,
        log.hand_no,
        log.rules_version,
        (0..n)
            .map(|k| format!(
                r#"{{"seat":{},"wallet":"{}"}}"#,
                log.seats[k], log.wallets[k]
            ))
            .collect::<Vec<_>>()
            .join(","),
        (0..n)
            .map(|k| format!("\"{}\"", hex(&log.salts[k])))
            .collect::<Vec<_>>()
            .join(","),
        hex(&log.vrf_output),
        hex(&log.roster_hash),
        hex(&log.hand_ctx),
        (0..n)
            .map(|k| format!("\"{}\"", hex(&log.salt_commitments[k])))
            .collect::<Vec<_>>()
            .join(","),
        hex(&log.vrf_caller_seed),
        hex(&log.merkle_root),
        player_cards,
    );
    let report = fairness_verifier::verify(&fairness_verifier::parse(&json).unwrap());
    assert_eq!(
        report.overall(),
        fairness_verifier::Status::Valid,
        "{}",
        report.render()
    );
    eprintln!("{}", report.render());
}
