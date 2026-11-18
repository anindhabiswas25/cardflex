//! Independent offline verifier for one Card Flex hand (CF-Fairness v2).
//!
//! Input: a hand record (JSON, format `cf-hand-record/1`) built from public
//! data only: the `HandLog` reveal plus any cards shown. Output: a report
//! with one line per check (PRD §22). It never asks the program, the backend
//! or the PER whether a hand was fair; it rebuilds everything from the spec
//! (`docs/spec/cf-fairness-v2.md`) and compares.
//!
//! Encodings: public keys are base58; hashes, salts and VRF output are hex.

use card_types::Card;
use fairness_core::{self as fc, Hash, SoftSha256 as H};
use serde::Deserialize;

pub const RECORD_FORMAT: &str = "cf-hand-record/1";

#[derive(Debug, Deserialize)]
pub struct SeatEntry {
    pub seat: u8,
    pub wallet: String,
}

#[derive(Debug, Deserialize)]
pub struct Claimed {
    pub roster_hash: String,
    pub hand_ctx: String,
    pub salt_commitments: Vec<String>,
    pub vrf_caller_seed: String,
    pub merkle_root: String,
}

#[derive(Debug, Deserialize)]
pub struct ShownHand {
    pub seat: u8,
    pub cards: Vec<u8>,
}

#[derive(Debug, Deserialize)]
pub struct HandRecord {
    pub format: String,
    pub protocol_version: u16,
    pub program_id: String,
    pub table: String,
    pub hand_no: String,
    pub rules_version: u16,
    /// Dealing order.
    pub seats: Vec<SeatEntry>,
    /// Dealing order.
    pub salts: Vec<String>,
    pub vrf_output: String,
    pub claimed: Claimed,
    /// Cards a player showed or received (e.g. at showdown). Optional.
    #[serde(default)]
    pub hands: Vec<ShownHand>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Valid,
    Invalid,
    NotProvided,
}

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Status::Valid => "VALID",
            Status::Invalid => "INVALID",
            Status::NotProvided => "NOT PROVIDED",
        }
    }
}

#[derive(Debug)]
pub struct Check {
    pub name: &'static str,
    pub status: Status,
    pub detail: String,
}

#[derive(Debug)]
pub struct Report {
    pub checks: Vec<Check>,
    /// The rebuilt deck (card ids by position), when the inputs parsed.
    pub deck: Option<Vec<u8>>,
}

impl Report {
    /// VALID only if every check is VALID or (for optional ones) not provided.
    pub fn overall(&self) -> Status {
        if self.checks.iter().any(|c| c.status == Status::Invalid) {
            Status::Invalid
        } else {
            Status::Valid
        }
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        for c in &self.checks {
            out.push_str(&format!(
                "{:<25} {:<13} {}\n",
                format!("{}:", c.name),
                c.status.label(),
                c.detail
            ));
        }
        out.push_str(&format!("{:<25} {}\n", "Overall:", self.overall().label()));
        out
    }
}

fn hex32(s: &str) -> Result<[u8; 32], String> {
    let s = s.trim_start_matches("0x");
    if s.len() != 64 {
        return Err(format!("expected 64 hex chars, got {}", s.len()));
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn key32(s: &str) -> Result<[u8; 32], String> {
    let v = bs58::decode(s).into_vec().map_err(|e| e.to_string())?;
    v.try_into()
        .map_err(|_| "public key must be 32 bytes".to_string())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Verifies one hand record.
pub fn verify(rec: &HandRecord) -> Report {
    let mut checks = Vec::new();
    let mut push = |name, ok: bool, detail: String| {
        checks.push(Check {
            name,
            status: if ok { Status::Valid } else { Status::Invalid },
            detail,
        })
    };

    let header_ok = rec.format == RECORD_FORMAT && rec.protocol_version == fc::PROTOCOL_VERSION;
    push(
        "Protocol version",
        header_ok,
        format!(
            "{} v{} (verifier supports {} v{})",
            rec.format,
            rec.protocol_version,
            RECORD_FORMAT,
            fc::PROTOCOL_VERSION
        ),
    );

    // Parse every input; a parse failure is itself an INVALID result.
    let parsed = (|| -> Result<_, String> {
        let program_id = key32(&rec.program_id)?;
        let table = key32(&rec.table)?;
        let hand_no: u64 = rec
            .hand_no
            .parse()
            .map_err(|_| "hand_no is not a u64".to_string())?;
        let n = rec.seats.len();
        if !(2..=fc::MAX_SEATS).contains(&n)
            || rec.salts.len() != n
            || rec.claimed.salt_commitments.len() != n
        {
            return Err(format!(
                "need 2..=6 seats with one salt and commitment each (got {n})"
            ));
        }
        let seats: Vec<fc::Seat> = rec
            .seats
            .iter()
            .map(|s| {
                Ok(fc::Seat {
                    index: s.seat,
                    wallet: key32(&s.wallet)?,
                })
            })
            .collect::<Result<_, String>>()?;
        let salts: Vec<[u8; 32]> = rec
            .salts
            .iter()
            .map(|s| hex32(s))
            .collect::<Result<_, _>>()?;
        let vrf = hex32(&rec.vrf_output)?;
        Ok((program_id, table, hand_no, seats, salts, vrf))
    })();
    let (program_id, table, hand_no, seats, salts, vrf) = match parsed {
        Ok(p) => p,
        Err(e) => {
            push("Record inputs", false, e);
            return Report { checks, deck: None };
        }
    };

    let claimed = |s: &str| hex32(s).unwrap_or([0xff; 32]);

    let roster = fc::roster_hash::<H>(&seats);
    push(
        "Roster hash",
        roster == claimed(&rec.claimed.roster_hash),
        hex(&roster),
    );

    let ctx: Hash = fc::hand_ctx::<H>(&fc::HandContext {
        program_id,
        table,
        hand_no,
        roster_hash: roster,
        rules_version: rec.rules_version,
    });
    push(
        "Game context",
        ctx == claimed(&rec.claimed.hand_ctx),
        hex(&ctx),
    );

    let commitments: Vec<Hash> = seats
        .iter()
        .zip(&salts)
        .map(|(s, salt)| fc::salt_commitment::<H>(&ctx, s.index, salt))
        .collect();
    let bad: Vec<u8> = seats
        .iter()
        .zip(&commitments)
        .zip(&rec.claimed.salt_commitments)
        .filter(|((_, c), want)| **c != claimed(want))
        .map(|((s, _), _)| s.index)
        .collect();
    push(
        "Salt commitments",
        bad.is_empty(),
        if bad.is_empty() {
            format!("{} salts match their commitments", seats.len())
        } else {
            format!("mismatch at seats {bad:?}")
        },
    );

    let caller_seed = fc::vrf_caller_seed::<H>(&ctx, &commitments);
    push(
        "Randomness binding",
        caller_seed == claimed(&rec.claimed.vrf_caller_seed),
        format!("VRF caller seed {}", hex(&caller_seed)),
    );

    let seed = fc::shuffle_seed::<H>(&ctx, &vrf, &salts);
    let (deck, _) = fc::shuffle::<H>(&seed);
    push(
        "Shuffle reconstruction",
        true,
        format!("seed {}", hex(&seed)),
    );
    push(
        "Deck uniqueness",
        card_types::is_complete_deck(&deck),
        "52 distinct cards".into(),
    );

    let leaves = fc::leaves::<H>(&ctx, &seed, &deck);
    let root = fc::merkle_root::<H>(&leaves);
    push(
        "Merkle root",
        root == claimed(&rec.claimed.merkle_root),
        hex(&root),
    );

    // Optional: cards a player received or showed must match the deal map.
    if rec.hands.is_empty() {
        checks.push(Check {
            name: "Dealing map",
            status: Status::NotProvided,
            detail: "no shown hands in the record".into(),
        });
    } else {
        let n = seats.len();
        let mut problems = Vec::new();
        for h in &rec.hands {
            match seats.iter().position(|s| s.index == h.seat) {
                None => problems.push(format!("seat {} not in roster", h.seat)),
                Some(k) => {
                    let expected: Vec<u8> = fc::deal_positions(k, n)
                        .iter()
                        .map(|&p| deck[p].id())
                        .collect();
                    let valid_ids = h.cards.iter().all(|&c| Card::from_id(c).is_ok());
                    if !valid_ids || h.cards != expected {
                        problems.push(format!(
                            "seat {}: shown {:?}, dealt {:?}",
                            h.seat, h.cards, expected
                        ));
                    }
                }
            }
        }
        let count = rec.hands.len();
        checks.push(Check {
            name: "Dealing map",
            status: if problems.is_empty() {
                Status::Valid
            } else {
                Status::Invalid
            },
            detail: if problems.is_empty() {
                format!("{count} shown hands match the deal")
            } else {
                problems.join("; ")
            },
        });
    }

    Report {
        checks,
        deck: Some(deck.iter().map(|c| c.id()).collect()),
    }
}

pub fn parse(json: &str) -> Result<HandRecord, String> {
    serde_json::from_str(json).map_err(|e| format!("not a valid {RECORD_FORMAT} record: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A record built from public data for a hand we construct here.
    fn record() -> (String, Vec<u8>) {
        let program_id = [0x11u8; 32];
        let table = [0x22u8; 32];
        let seats: Vec<fc::Seat> = (0..3)
            .map(|i| fc::Seat {
                index: [0, 2, 5][i],
                wallet: [0xa0 + i as u8; 32],
            })
            .collect();
        let salts: Vec<[u8; 32]> = (0..3).map(|i| [0xb0 + i as u8; 32]).collect();
        let vrf = [0x42u8; 32];
        let roster = fc::roster_hash::<H>(&seats);
        let ctx = fc::hand_ctx::<H>(&fc::HandContext {
            program_id,
            table,
            hand_no: 9,
            roster_hash: roster,
            rules_version: 1,
        });
        let comm: Vec<Hash> = seats
            .iter()
            .zip(&salts)
            .map(|(s, x)| fc::salt_commitment::<H>(&ctx, s.index, x))
            .collect();
        let cseed = fc::vrf_caller_seed::<H>(&ctx, &comm);
        let seed = fc::shuffle_seed::<H>(&ctx, &vrf, &salts);
        let (deck, _) = fc::shuffle::<H>(&seed);
        let root = fc::merkle_root::<H>(&fc::leaves::<H>(&ctx, &seed, &deck));
        let shown: Vec<u8> = fc::deal_positions(1, 3)
            .iter()
            .map(|&p| deck[p].id())
            .collect();
        let b58 = |k: &[u8; 32]| bs58::encode(k).into_string();
        let json = format!(
            r#"{{"format":"{RECORD_FORMAT}","protocol_version":2,"program_id":"{}","table":"{}","hand_no":"9","rules_version":1,
               "seats":[{}],"salts":[{}],"vrf_output":"{}",
               "claimed":{{"roster_hash":"{}","hand_ctx":"{}","salt_commitments":[{}],"vrf_caller_seed":"{}","merkle_root":"{}"}},
               "hands":[{{"seat":2,"cards":{:?}}}]}}"#,
            b58(&program_id),
            b58(&table),
            seats
                .iter()
                .map(|s| format!(r#"{{"seat":{},"wallet":"{}"}}"#, s.index, b58(&s.wallet)))
                .collect::<Vec<_>>()
                .join(","),
            salts
                .iter()
                .map(|s| format!("\"{}\"", hex(s)))
                .collect::<Vec<_>>()
                .join(","),
            hex(&vrf),
            hex(&roster),
            hex(&ctx),
            comm.iter()
                .map(|c| format!("\"{}\"", hex(c)))
                .collect::<Vec<_>>()
                .join(","),
            hex(&cseed),
            hex(&root),
            shown,
        );
        (json, deck.iter().map(|c| c.id()).collect())
    }

    #[test]
    fn honest_record_is_valid() {
        let (json, deck) = record();
        let rep = verify(&parse(&json).unwrap());
        assert_eq!(rep.overall(), Status::Valid, "{}", rep.render());
        assert_eq!(rep.deck.as_ref().unwrap(), &deck);
        assert!(
            rep.checks.iter().all(|c| c.status == Status::Valid),
            "{}",
            rep.render()
        );
    }

    fn flip_hex_field(json: &str, key: &str) -> String {
        let k = format!("\"{key}\":\"");
        let i = json.find(&k).unwrap() + k.len();
        let c = if &json[i..i + 1] == "0" { "1" } else { "0" };
        format!("{}{}{}", &json[..i], c, &json[i + 1..])
    }

    fn failed(json: &str) -> Vec<&'static str> {
        let rep = verify(&parse(json).unwrap());
        assert_eq!(rep.overall(), Status::Invalid, "{}", rep.render());
        rep.checks
            .iter()
            .filter(|c| c.status == Status::Invalid)
            .map(|c| c.name)
            .collect()
    }

    #[test]
    fn each_tampered_field_is_caught_at_the_right_check() {
        let (json, _) = record();
        assert_eq!(
            failed(&flip_hex_field(&json, "merkle_root")),
            vec!["Merkle root"]
        );
        assert_eq!(
            failed(&flip_hex_field(&json, "vrf_caller_seed")),
            vec!["Randomness binding"]
        );
        assert_eq!(
            failed(&flip_hex_field(&json, "roster_hash")),
            vec!["Roster hash"]
        );
        assert_eq!(
            failed(&flip_hex_field(&json, "hand_ctx")),
            vec!["Game context"]
        );
        // A different VRF output changes the deck: the root no longer matches.
        assert_eq!(
            failed(&flip_hex_field(&json, "vrf_output")),
            vec!["Merkle root", "Dealing map"]
        );
        // A substituted salt breaks its commitment and everything after it.
        let salt_tampered = json.replacen("\"salts\":[\"b0", "\"salts\":[\"c0", 1);
        assert_eq!(
            failed(&salt_tampered),
            vec![
                "Salt commitments",
                "Randomness binding",
                "Merkle root",
                "Dealing map"
            ]
        );
        // A player claiming other cards.
        let shown = json.replace(
            "\"hands\":[{\"seat\":2,\"cards\":[",
            "\"hands\":[{\"seat\":2,\"cards\":[51,",
        );
        let shown = shown.replacen("51,", "", 0);
        let mut v: serde_json::Value = serde_json::from_str(&shown).unwrap();
        v["hands"][0]["cards"][0] =
            serde_json::json!(51 - v["hands"][0]["cards"][0].as_u64().unwrap() % 52);
        assert_eq!(failed(&v.to_string()), vec!["Dealing map"]);
        // Wrong protocol version.
        assert!(
            failed(&json.replace("\"protocol_version\":2", "\"protocol_version\":3"))
                .contains(&"Protocol version")
        );
    }

    #[test]
    fn spec_vectors_verify() {
        // Every case in docs/spec/vectors must pass the verifier.
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/spec/vectors/cf-fairness-v2.json"
        ))
        .unwrap();
        for case in v["cases"].as_array().unwrap() {
            let i = &case["input"];
            let o = &case["output"];
            let b58hex = |h: &serde_json::Value| {
                bs58::encode(hex32(h.as_str().unwrap()).unwrap()).into_string()
            };
            let seats: Vec<String> = i["seats"]
                .as_array()
                .unwrap()
                .iter()
                .zip(i["wallets"].as_array().unwrap())
                .map(|(s, w)| format!(r#"{{"seat":{},"wallet":"{}"}}"#, s, b58hex(w)))
                .collect();
            let json = format!(
                r#"{{"format":"{RECORD_FORMAT}","protocol_version":2,"program_id":"{}","table":"{}","hand_no":{},"rules_version":{},
                   "seats":[{}],"salts":{},"vrf_output":{},
                   "claimed":{{"roster_hash":{},"hand_ctx":{},"salt_commitments":{},"vrf_caller_seed":{},"merkle_root":{}}},
                   "hands":[{}]}}"#,
                b58hex(&i["program_id"]),
                b58hex(&i["table"]),
                i["hand_no"],
                i["rules_version"],
                seats.join(","),
                i["salts"],
                i["vrf_output"],
                o["roster_hash"],
                o["hand_ctx"],
                o["salt_commitments"],
                o["vrf_caller_seed"],
                o["merkle_root"],
                o["deal"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|d| format!(r#"{{"seat":{},"cards":{}}}"#, d["seat"], d["cards"]))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            let rep = verify(&parse(&json).unwrap());
            assert_eq!(
                rep.overall(),
                Status::Valid,
                "{}: {}",
                case["name"],
                rep.render()
            );
        }
    }
}

#[cfg(test)]
mod g2 {
    use super::*;
    use fairness_core::Sha256 as _;

    fn hexs(b: &[u8]) -> String {
        hex(b)
    }

    /// Gate G2 (PRD §13.6): the verifier rebuilds 10,000 hands. Inputs are
    /// derived pseudo-randomly; each honest record must be VALID and the same
    /// record with one random field changed must be INVALID.
    #[test]
    #[ignore = "slow in debug; run with: cargo test -p fairness-verifier --release -- --ignored"]
    fn ten_thousand_random_hands() {
        let mut valid = 0;
        let mut caught = 0;
        for i in 0..10_000u64 {
            let r = |tag: &[u8]| H::hashv(&[b"g2", &i.to_le_bytes(), tag]);
            let n = 2 + (r(b"n")[0] as usize % 5); // 2..=6 seats
            let program_id = r(b"program");
            let table = r(b"table");
            let hand_no = u64::from_le_bytes(r(b"hand")[..8].try_into().unwrap());
            let seats: Vec<fc::Seat> = (0..n)
                .map(|k| fc::Seat {
                    index: k as u8,
                    wallet: r(&[b'w', k as u8]),
                })
                .collect();
            let salts: Vec<[u8; 32]> = (0..n).map(|k| r(&[b's', k as u8])).collect();
            let vrf = r(b"vrf");
            let roster = fc::roster_hash::<H>(&seats);
            let ctx = fc::hand_ctx::<H>(&fc::HandContext {
                program_id,
                table,
                hand_no,
                roster_hash: roster,
                rules_version: 1,
            });
            let comm: Vec<Hash> = seats
                .iter()
                .zip(&salts)
                .map(|(s, x)| fc::salt_commitment::<H>(&ctx, s.index, x))
                .collect();
            let seed = fc::shuffle_seed::<H>(&ctx, &vrf, &salts);
            let (deck, _) = fc::shuffle::<H>(&seed);
            let root = fc::merkle_root::<H>(&fc::leaves::<H>(&ctx, &seed, &deck));
            let k = (r(b"k")[0] as usize) % n;
            let mut rec = HandRecord {
                format: RECORD_FORMAT.into(),
                protocol_version: 2,
                program_id: bs58::encode(program_id).into_string(),
                table: bs58::encode(table).into_string(),
                hand_no: hand_no.to_string(),
                rules_version: 1,
                seats: seats
                    .iter()
                    .map(|s| SeatEntry {
                        seat: s.index,
                        wallet: bs58::encode(s.wallet).into_string(),
                    })
                    .collect(),
                salts: salts.iter().map(|s| hexs(s)).collect(),
                vrf_output: hexs(&vrf),
                claimed: Claimed {
                    roster_hash: hexs(&roster),
                    hand_ctx: hexs(&ctx),
                    salt_commitments: comm.iter().map(|c| hexs(c)).collect(),
                    vrf_caller_seed: hexs(&fc::vrf_caller_seed::<H>(&ctx, &comm)),
                    merkle_root: hexs(&root),
                },
                hands: vec![ShownHand {
                    seat: k as u8,
                    cards: fc::deal_positions(k, n)
                        .iter()
                        .map(|&p| deck[p].id())
                        .collect(),
                }],
            };
            if verify(&rec).overall() == Status::Valid {
                valid += 1;
            }
            // One random tamper per hand.
            match r(b"tamper")[0] % 5 {
                0 => rec.salts[k] = hexs(&r(b"other-salt")),
                1 => rec.vrf_output = hexs(&r(b"other-vrf")),
                2 => rec.claimed.merkle_root = hexs(&r(b"other-root")),
                3 => rec.hand_no = hand_no.wrapping_add(1).to_string(),
                _ => rec.hands[0].cards[0] = (rec.hands[0].cards[0] + 1) % 52,
            }
            if verify(&rec).overall() == Status::Invalid {
                caught += 1;
            }
        }
        assert_eq!((valid, caught), (10_000, 10_000));
    }
}
