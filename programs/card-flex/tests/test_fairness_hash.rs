//! The program hashes through `SolSha256` (the `sol_sha256` syscall on-chain).
//! On the host it must give exactly the CF-Fairness v2 vector values.

use card_flex::table::SolSha256;
use fairness_core::{hand_ctx, roster_hash, salt_commitment, HandContext, Seat};

fn field<'a>(json: &'a str, key: &str) -> &'a str {
    let k = format!("\"{key}\": \"");
    let start = json.find(&k).expect(key) + k.len();
    &json[start..start + 64]
}

fn hex32(s: &str) -> [u8; 32] {
    core::array::from_fn(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
}

#[test]
fn program_hasher_reproduces_the_six_seat_vector() {
    let json = include_str!("../../../docs/spec/vectors/cf-fairness-v2.json");
    // Inputs of case "six-seats" (see crates/fairness-core/tests/vectors.rs).
    let seats: Vec<Seat> = (0..6u8)
        .map(|i| Seat {
            index: i,
            wallet: [0xa0 + i; 32],
        })
        .collect();
    let roster = roster_hash::<SolSha256>(&seats);
    assert_eq!(roster, hex32(field(json, "roster_hash")));
    let ctx = hand_ctx::<SolSha256>(&HandContext {
        program_id: [0x11; 32],
        table: [0x22; 32],
        hand_no: 7,
        roster_hash: roster,
        rules_version: 1,
    });
    assert_eq!(ctx, hex32(field(json, "hand_ctx")));
    let commitments_at =
        json.find("\"salt_commitments\": [\"").unwrap() + "\"salt_commitments\": [\"".len();
    assert_eq!(
        salt_commitment::<SolSha256>(&ctx, 0, &[0xb0; 32]),
        hex32(&json[commitments_at..commitments_at + 64])
    );
}
