//! `cf-verify <record.json>`: verify one Card Flex hand offline.
//! Exit status: 0 = VALID, 1 = INVALID, 2 = usage or unreadable record.

use fairness_verifier::{parse, verify, Status};

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: cf-verify <hand-record.json>");
        std::process::exit(2);
    };
    let json = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            std::process::exit(2);
        }
    };
    let record = match parse(&json) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let report = verify(&record);
    print!("{}", report.render());
    std::process::exit(if report.overall() == Status::Valid {
        0
    } else {
        1
    });
}
