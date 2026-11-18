//! Teen Patti rules v1 (`docs/spec/teen-patti-rules-v1.md`).
//! `no_std`, deterministic, no I/O: shared by the program, the verifier and
//! the browser.

#![no_std]
#![forbid(unsafe_code)]

pub mod game;
pub mod rank;

pub use rank::{evaluate, Category, HandRank};
