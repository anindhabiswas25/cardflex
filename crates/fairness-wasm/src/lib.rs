//! `cf-verify` as WebAssembly (CF-040). The same verifier as the CLI, with a
//! tiny C ABI so no extra build tools are needed:
//!
//! - `cf_alloc(len) -> ptr`, `cf_free(ptr, len)` manage buffers in WASM memory;
//! - `cf_verify(ptr, len) -> u64` takes a `cf-hand-record/2` (or `/1`) JSON
//!   and returns `(out_ptr << 32) | out_len` of a JSON report the caller
//!   must free:
//!   `{"overall": "VALID"|"INVALID", "checks": [{"name", "status", "detail"}],
//!     "deck": [card ids] | null, "error": null | "message"}`.
//!
//! The JS glue lives in `packages/client-sdk/src/verifier.ts`.

use fairness_verifier::{parse, verify, Report, Status};

/// Verifies one hand record (JSON) and returns the report as JSON.
pub fn verify_json(input: &str) -> String {
    let value = match parse(input) {
        Ok(rec) => report_json(&verify(&rec), None),
        Err(e) => {
            serde_json::json!({ "overall": "INVALID", "checks": [], "deck": null, "error": e })
        }
    };
    value.to_string()
}

fn report_json(r: &Report, error: Option<String>) -> serde_json::Value {
    serde_json::json!({
        "overall": r.overall().label(),
        "checks": r.checks.iter().map(|c| serde_json::json!({
            "name": c.name,
            "status": c.status.label(),
            "detail": c.detail,
        })).collect::<Vec<_>>(),
        "deck": r.deck,
        "error": error,
    })
}

/// Same verdict as the CLI's exit status (for tests).
pub fn is_valid(input: &str) -> bool {
    parse(input)
        .map(|rec| verify(&rec).overall() == Status::Valid)
        .unwrap_or(false)
}

#[no_mangle]
pub extern "C" fn cf_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from `cf_alloc` (or a `cf_verify` result) and be freed once.
#[no_mangle]
pub unsafe extern "C" fn cf_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// # Safety
/// `ptr`/`len` must describe a live buffer holding the record JSON.
#[no_mangle]
pub unsafe extern "C" fn cf_verify(ptr: *const u8, len: usize) -> u64 {
    let input = std::slice::from_raw_parts(ptr, len);
    let out = match std::str::from_utf8(input) {
        Ok(s) => verify_json(s),
        Err(_) => r#"{"overall":"INVALID","checks":[],"deck":null,"error":"record is not UTF-8"}"#
            .to_string(),
    };
    let mut bytes = out.into_bytes();
    bytes.shrink_to_fit();
    let (p, l) = (bytes.as_mut_ptr(), bytes.len());
    std::mem::forget(bytes);
    ((p as u64) << 32) | l as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_input_is_an_invalid_report_not_a_crash() {
        let v: serde_json::Value = serde_json::from_str(&verify_json("not json")).unwrap();
        assert_eq!(v["overall"], "INVALID");
        assert!(v["error"].as_str().unwrap().contains("not a valid"));
    }
}
