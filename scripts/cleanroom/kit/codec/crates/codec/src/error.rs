//! Shared error type for every codec in this crate.

use core::fmt;

/// Why an encoding or decoding was rejected.
///
/// Variants are deliberately coarse: they name the rule that failed, not the
/// byte offset, so they can be produced by allocation-free cores.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Error {
    /// The input ended before the structure was complete.
    Truncated,
    /// A sign, prefix, suffix or magic marker was not the expected one.
    BadPrefix,
    /// A character or byte outside the permitted alphabet.
    BadDigit,
    /// A Lexidecimal size field was wider than necessary.
    NonCanonicalSize,
    /// The payload had leading zero digits/bytes (or was empty).
    NonMinimal,
    /// A declared length disagrees with the data present.
    LengthMismatch,
    /// A value does not fit the target representation.
    Overflow,
    /// The output buffer is too small.
    BufferTooSmall,
    /// An EnvBuf header and footer disagree.
    FramingMismatch,
    /// EnvBuf alignment padding was not all `0xee`.
    BadPadding,
    /// A reserved EnvBuf format code.
    ReservedFormat,
    /// An EnvBuf alignment power or format out of range.
    BadDescriptor,
    /// Nesting exceeded the supported depth.
    TooDeep,
    /// The FlexBuffers root is not a `VT_VECTOR_UINT` extension.
    NotExtension,
    /// An unknown extension prefix byte.
    UnknownExtension,
    /// Malformed FlexBuffers layout (offsets, widths, bounds).
    BadLayout,
    /// Text that is not valid UTF-8 / Unicode scalar values.
    BadUtf8,
    /// A well-known symbol name outside the permitted set.
    UnknownSymbol,
    /// Malformed JSON syntax.
    BadJson,
    /// A JSON object repeated a key.
    DuplicateKey,
    /// A reserved or invalid JSON0 `0` prefix.
    ReservedPrefix,
    /// Invalid base64/base64url text.
    BadBase64,
    /// A malformed decimal integer or real.
    BadNumber,
    /// A Flow id outside the permitted alphabet/length.
    BadFlowId,
    /// An object key that does not match its pattern.
    BadKey,
    /// A position outside its permitted range (e.g. Milestone < 1).
    OutOfRange,
}

impl Error {
    /// Short stable message, used by the oracle.
    pub const fn message(self) -> &'static str {
        match self {
            Error::Truncated => "truncated input",
            Error::BadPrefix => "bad prefix, suffix or magic",
            Error::BadDigit => "character outside the permitted alphabet",
            Error::NonCanonicalSize => "non-canonical size width",
            Error::NonMinimal => "non-minimal payload",
            Error::LengthMismatch => "length mismatch",
            Error::Overflow => "value out of representable range",
            Error::BufferTooSmall => "output buffer too small",
            Error::FramingMismatch => "header and footer disagree",
            Error::BadPadding => "alignment padding is not 0xee",
            Error::ReservedFormat => "reserved EnvBuf format",
            Error::BadDescriptor => "bad EnvBuf descriptor",
            Error::TooDeep => "nesting too deep",
            Error::NotExtension => "FlexBuffers root is not a VT_VECTOR_UINT extension",
            Error::UnknownExtension => "unknown extension prefix",
            Error::BadLayout => "malformed FlexBuffers layout",
            Error::BadUtf8 => "invalid UTF-8 or Unicode scalar text",
            Error::UnknownSymbol => "unknown well-known symbol",
            Error::BadJson => "malformed JSON",
            Error::DuplicateKey => "duplicate object key",
            Error::ReservedPrefix => "reserved or invalid JSON0 prefix",
            Error::BadBase64 => "invalid base64",
            Error::BadNumber => "malformed number",
            Error::BadFlowId => "invalid Flow id",
            Error::BadKey => "object key does not match its pattern",
            Error::OutOfRange => "value out of permitted range",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for Error {}

/// Convenience alias.
pub type Result<T> = core::result::Result<T, Error>;
