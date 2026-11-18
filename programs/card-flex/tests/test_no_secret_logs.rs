//! CF-007: program logs are invisible to clients in PER (even the table
//! authority got 0 log lines), so "no secrets in logs" is enforced here, in
//! the source: every `msg!` must be on this allow-list of fixed strings.

const ALLOWED: &[&str] = &[
    r#"msg!("card-flex protocol v{}", PROTOCOL_VERSION);"#,
    r#"msg!("permission exists");"#,
];

#[test]
fn every_msg_is_allow_listed() {
    for (file, src) in [
        ("lib.rs", include_str!("../src/lib.rs")),
        ("table.rs", include_str!("../src/table.rs")),
    ] {
        for (n, line) in src.lines().enumerate() {
            let line = line.trim();
            if line.contains("msg!(") && !line.starts_with("//") {
                assert!(
                    ALLOWED.contains(&line),
                    "{file}:{} logs something not on the allow-list: {line}",
                    n + 1
                );
            }
        }
    }
}
