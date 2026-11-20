//! CF-059: MagicBlock doesn't say whether an empty permission member list
//! means "public" or "nobody". The program must never create or update a
//! permission with one. Every `EphemeralMembersArgs` in the source takes its
//! members from a form that is non-empty by construction (or checked).

/// Accepted `members` expressions and why each is never empty.
const ALLOWED: &[&str] = &[
    "members: vec![Member {", // literal with one entry
    "members,", // runtime_members (always has the authority) or create_permission_with (checked)
    "members: rt_members,", // runtime_members (always has the authority)
    "members: readers", // update_hand_readers (checked: 1..=MAX_HAND_READERS)
];

#[test]
fn no_permission_can_have_an_empty_member_list() {
    let src = include_str!("../src/lib.rs");
    let lines: Vec<&str> = src.lines().map(str::trim).collect();
    let mut seen = 0;
    for (n, line) in lines.iter().enumerate() {
        if !line.starts_with("args: EphemeralMembersArgs {") {
            continue;
        }
        seen += 1;
        let members = lines[n + 1..n + 4]
            .iter()
            .find(|l| l.starts_with("members"))
            .unwrap_or_else(|| panic!("lib.rs:{}: no members field", n + 1));
        assert!(
            ALLOWED.iter().any(|a| members.starts_with(a)),
            "lib.rs:{}: unreviewed member list `{members}`; add it to ALLOWED only if it can never be empty",
            n + 1
        );
    }
    assert!(
        seen >= 7,
        "found only {seen} permission writes; did the code move?"
    );
    // The two checked paths keep their checks.
    assert!(src.contains("!is_private || !members.is_empty(),"));
    // The only public permission is HandLog's (empty list, is_private = false).
    assert_eq!(
        src.matches("create_permission_with(").count(),
        2,
        "calls: create_permission and HandLog"
    );
    let hl = src
        .split("pub fn open_hand_log_permission(")
        .nth(1)
        .unwrap();
    let hl = &hl[..hl.find("\n    }\n").unwrap()];
    assert!(
        hl.contains("vec![],") && hl.contains("false,"),
        "HandLog: public, no members"
    );
    assert!(src.contains("!readers.is_empty() && readers.len() <= MAX_HAND_READERS"));
    // runtime_members starts from the authority.
    let rm = src.split("fn runtime_members(").nth(1).unwrap();
    assert!(rm[..rm.find("\n}\n").unwrap()].contains("pubkey: runtime.authority"));
}
