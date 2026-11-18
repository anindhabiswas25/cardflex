//! Frozen CF-Fairness v2 test vectors.
//!
//! `docs/spec/vectors/cf-fairness-v2.json` is generated from this file and
//! committed. The test fails if the implementation drifts from it. After an
//! intentional protocol change (new version), regenerate with:
//!
//!   CF_WRITE_VECTORS=1 cargo test -p fairness-core --test vectors
//!
//! `scripts/check_fairness_vectors.py` re-derives every value from the spec
//! with Python's standard library, independently of this crate.

use fairness_core::*;
use std::fmt::Write as _;

type H = SoftSha256;

struct Case {
    name: &'static str,
    program_id: [u8; 32],
    table: [u8; 32],
    hand_no: u64,
    rules_version: u16,
    seats: Vec<Seat>,
    salts: Vec<[u8; 32]>,
    vrf_output: [u8; 32],
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "six-seats",
            program_id: [0x11; 32],
            table: [0x22; 32],
            hand_no: 7,
            rules_version: 1,
            seats: (0..6)
                .map(|i| Seat {
                    index: i,
                    wallet: [0xa0 + i; 32],
                })
                .collect(),
            salts: (0..6).map(|i| [0xb0 + i; 32]).collect(),
            vrf_output: core::array::from_fn(|i| i as u8),
        },
        Case {
            name: "two-seats-gapped",
            program_id: [0x33; 32],
            table: [0x44; 32],
            hand_no: 0,
            rules_version: 1,
            seats: vec![
                Seat {
                    index: 1,
                    wallet: [0xc1; 32],
                },
                Seat {
                    index: 4,
                    wallet: [0xc4; 32],
                },
            ],
            salts: vec![[0xd1; 32], [0xd4; 32]],
            vrf_output: [0xff; 32],
        },
        Case {
            name: "three-seats-high-hand",
            program_id: [0x55; 32],
            table: [0x66; 32],
            hand_no: u64::MAX,
            rules_version: 1,
            seats: vec![
                Seat {
                    index: 0,
                    wallet: [0x01; 32],
                },
                Seat {
                    index: 2,
                    wallet: [0x02; 32],
                },
                Seat {
                    index: 5,
                    wallet: [0x03; 32],
                },
            ],
            salts: vec![[0x00; 32], [0x7f; 32], [0xfe; 32]],
            vrf_output: [0x5a; 32],
        },
    ]
}

fn hex(b: &[u8]) -> String {
    b.iter().fold(String::new(), |mut s, x| {
        let _ = write!(s, "{x:02x}");
        s
    })
}
fn hex_list<T: AsRef<[u8]>>(xs: &[T]) -> String {
    let items: Vec<String> = xs
        .iter()
        .map(|x| format!("\"{}\"", hex(x.as_ref())))
        .collect();
    format!("[{}]", items.join(", "))
}
fn num_list<T: std::fmt::Display>(xs: impl IntoIterator<Item = T>) -> String {
    let items: Vec<String> = xs.into_iter().map(|x| x.to_string()).collect();
    format!("[{}]", items.join(", "))
}

fn render() -> String {
    let mut out = String::from(
        "{\n  \"protocol\": \"CF-Fairness\",\n  \"protocol_version\": 2,\n  \"cases\": [\n",
    );
    let cs = cases();
    for (ci, c) in cs.iter().enumerate() {
        let roster = roster_hash::<H>(&c.seats);
        let ctx = hand_ctx::<H>(&HandContext {
            program_id: c.program_id,
            table: c.table,
            hand_no: c.hand_no,
            roster_hash: roster,
            rules_version: c.rules_version,
        });
        let commitments: Vec<Hash> = c
            .seats
            .iter()
            .zip(&c.salts)
            .map(|(s, salt)| salt_commitment::<H>(&ctx, s.index, salt))
            .collect();
        let caller_seed = vrf_caller_seed::<H>(&ctx, &commitments);
        let seed = shuffle_seed::<H>(&ctx, &c.vrf_output, &c.salts);
        let mut rng = Drbg::<H>::new(seed);
        let first_words: Vec<u32> = (0..16).map(|_| rng.next_u32()).collect();
        let (deck, words_used) = shuffle::<H>(&seed);
        let lv = leaves::<H>(&ctx, &seed, &deck);
        let root = merkle_root::<H>(&lv);
        let n = c.seats.len();
        let deal: Vec<String> = c
            .seats
            .iter()
            .enumerate()
            .map(|(k, s)| {
                let pos = deal_positions(k, n);
                format!(
                    "{{\"seat\": {}, \"positions\": {}, \"cards\": {}}}",
                    s.index,
                    num_list(pos),
                    num_list(pos.map(|p| deck[p].id()))
                )
            })
            .collect();
        let proof_positions = [0usize, 17, 51];
        let proofs: Vec<String> = proof_positions
            .iter()
            .map(|&p| {
                format!(
                    "{{\"position\": {p}, \"leaf_salt\": \"{}\", \"leaf\": \"{}\", \"siblings\": {}}}",
                    hex(&leaf_salt::<H>(&seed, p as u8)),
                    hex(&lv[p]),
                    hex_list(&merkle_proof::<H>(&lv, p))
                )
            })
            .collect();
        let _ = write!(
            out,
            "    {{\n      \"name\": \"{name}\",\n      \"input\": {{\n        \"program_id\": \"{pid}\",\n        \"table\": \"{tbl}\",\n        \"hand_no\": \"{hand}\",\n        \"rules_version\": {rv},\n        \"seats\": {seats},\n        \"wallets\": {wallets},\n        \"salts\": {salts},\n        \"vrf_output\": \"{vrf}\"\n      }},\n      \"output\": {{\n        \"roster_hash\": \"{roster}\",\n        \"hand_ctx\": \"{ctx}\",\n        \"salt_commitments\": {comm},\n        \"vrf_caller_seed\": \"{cseed}\",\n        \"shuffle_seed\": \"{seed}\",\n        \"drbg_first_16_words\": {words},\n        \"drbg_words_used_by_shuffle\": {used},\n        \"deck\": {deck},\n        \"empty_leaf_52\": \"{empty}\",\n        \"merkle_root\": \"{root}\",\n        \"proofs\": [{proofs}],\n        \"deal\": [{deal}]\n      }}\n    }}{comma}\n",
            name = c.name,
            pid = hex(&c.program_id),
            tbl = hex(&c.table),
            hand = c.hand_no,
            rv = c.rules_version,
            seats = num_list(c.seats.iter().map(|s| s.index)),
            wallets = hex_list(&c.seats.iter().map(|s| s.wallet).collect::<Vec<_>>()),
            salts = hex_list(&c.salts),
            vrf = hex(&c.vrf_output),
            roster = hex(&roster),
            ctx = hex(&ctx),
            comm = hex_list(&commitments),
            cseed = hex(&caller_seed),
            seed = hex(&seed),
            words = num_list(first_words),
            used = words_used,
            deck = num_list(deck.iter().map(|c| c.id())),
            empty = hex(&empty_leaf::<H>(52)),
            root = hex(&root),
            proofs = proofs.join(", "),
            deal = deal.join(", "),
            comma = if ci + 1 < cs.len() { "," } else { "" },
        );
    }
    out.push_str("  ]\n}\n");
    out
}

#[test]
fn vectors_are_frozen() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/spec/vectors/cf-fairness-v2.json"
    );
    let rendered = render();
    if std::env::var("CF_WRITE_VECTORS").as_deref() == Ok("1") {
        std::fs::write(path, &rendered).unwrap();
        return;
    }
    let committed =
        std::fs::read_to_string(path).expect("vectors file missing; run with CF_WRITE_VECTORS=1");
    assert!(
        committed == rendered,
        "CF-Fairness v2 output changed. If intentional, bump PROTOCOL_VERSION and regenerate."
    );
}

/// Each card should land in each position about equally often. Chi-square over
/// 52 cards at three positions, 20,000 shuffles; 51 degrees of freedom, the
/// 99.9% critical value is about 87.
#[test]
fn shuffle_positions_look_uniform() {
    const N: usize = 20_000;
    for &pos in &[0usize, 25, 51] {
        let mut counts = [0usize; 52];
        for i in 0..N {
            let seed = H::hashv(&[b"uniformity", &(i as u64).to_le_bytes()]);
            let (deck, _) = shuffle::<H>(&seed);
            counts[deck[pos].id() as usize] += 1;
        }
        let expected = N as f64 / 52.0;
        let chi2: f64 = counts
            .iter()
            .map(|&c| (c as f64 - expected).powi(2) / expected)
            .sum();
        assert!(chi2 < 87.0, "position {pos}: chi2 = {chi2:.1}");
    }
}
