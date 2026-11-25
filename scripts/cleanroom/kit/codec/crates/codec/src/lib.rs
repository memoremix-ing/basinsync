//! Clean-room basinsync codecs, rebuilt from the basinsync documentation.
//!
//! | Module | Documentation |
//! | --- | --- |
//! | [`lexidecimal`] | `docs/glossary/lexidecimal.md` (including size prefixes) |
//! | [`diffuse16`] | `docs/glossary/diffuse16.md` |
//! | [`envbuf`] | `docs/glossary/envbuf.md`, `docs/glossary/margin.md` |
//! | [`flexbuffers`] | `docs/glossary/flexbuffers.md` (extensions) |
//! | [`json0`] | `docs/glossary/json0.md` |
//! | [`crc32c`] | `docs/glossary/crc32c.md` |
//! | [`sha384`] | `docs/glossary/sha384.md` |
//! | [`keys`] | `docs/object-keys.md` (prefixes, key builders, Flow ids) |
//!
//! The crate has no runtime dependencies. Each codec has an
//! allocation-free core that the Kani harnesses in `kani_proofs` verify;
//! the allocating public API wraps those cores.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod bigint;
pub mod crc32c;
pub mod diffuse16;
pub mod envbuf;
mod error;
pub mod flexbuffers;
pub mod hex;
pub mod json0;
pub mod keys;
pub mod layout;
pub mod lexidecimal;
pub mod sha384;

#[cfg(kani)]
mod kani_proofs;

pub use bigint::BigInt;
pub use error::{Error, Result};
