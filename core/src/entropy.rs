//! Two-source entropy combiner. See PLAN.md §3 and ENTROPY.md.
//!
//! The web layer supplies 32 bytes drawn from `crypto.getRandomValues()` and
//! the user's raw dice-roll string. This module re-validates both sources
//! independently — it never trusts the JavaScript layer — then derives
//! 32 bytes from the dice via SHA-256 and XORs the two sources.
//!
//! Every validation failure is a hard error. There is no fallback source, no
//! default value, and no path that produces output from fewer than two
//! healthy sources. Error messages name the failed check and never include
//! source bytes or dice values.

use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

pub const PLATFORM_ENTROPY_LEN: usize = 32;
pub const MIN_DICE_ROLLS: usize = 50;

/// Inputs that must never be used as entropy sources, kept as a named list
/// per PLAN.md. An attacker can enumerate every one of these.
pub const REJECTED_SOURCES: [&str; 6] = [
    "device identifiers (serial, IMEI, Android ID)",
    "timestamps or clock registers",
    "boot time or uptime",
    "process or thread IDs",
    "MAC or IP addresses",
    "Math.random or any non-CSPRNG generator",
];

#[derive(Debug, PartialEq, Eq)]
pub enum EntropyError {
    PlatformWrongLength { got: usize },
    PlatformBytesAllIdentical,
    TooFewDiceRolls { got: usize },
    InvalidDiceRoll,
}

impl core::fmt::Display for EntropyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            EntropyError::PlatformWrongLength { got } => write!(
                f,
                "platform entropy must be exactly {PLATFORM_ENTROPY_LEN} bytes, got {got}"
            ),
            EntropyError::PlatformBytesAllIdentical => {
                write!(f, "platform entropy failed health check: all bytes identical")
            }
            EntropyError::TooFewDiceRolls { got } => {
                write!(f, "at least {MIN_DICE_ROLLS} dice rolls required, got {got}")
            }
            EntropyError::InvalidDiceRoll => {
                write!(f, "dice rolls must contain only the characters 1-6")
            }
        }
    }
}

/// Validate both sources and combine them: SHA-256(dice) XOR platform.
pub fn combine_entropy(
    platform: &[u8],
    dice_rolls: &str,
) -> Result<[u8; PLATFORM_ENTROPY_LEN], EntropyError> {
    if platform.len() != PLATFORM_ENTROPY_LEN {
        return Err(EntropyError::PlatformWrongLength { got: platform.len() });
    }
    if platform.iter().all(|&b| b == platform[0]) {
        return Err(EntropyError::PlatformBytesAllIdentical);
    }
    let roll_count = dice_rolls.chars().count();
    if roll_count < MIN_DICE_ROLLS {
        return Err(EntropyError::TooFewDiceRolls { got: roll_count });
    }
    if !dice_rolls.chars().all(|c| ('1'..='6').contains(&c)) {
        return Err(EntropyError::InvalidDiceRoll);
    }

    let mut dice_digest: [u8; PLATFORM_ENTROPY_LEN] =
        Sha256::digest(dice_rolls.as_bytes()).into();
    let mut out = [0u8; PLATFORM_ENTROPY_LEN];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = platform[i] ^ dice_digest[i];
    }
    dice_digest.zeroize();
    Ok(out)
}

/// wasm-bindgen boundary for [`combine_entropy`].
#[wasm_bindgen]
pub fn combine_entropy_js(platform: &[u8], dice_rolls: &str) -> Result<Vec<u8>, JsError> {
    combine_entropy(platform, dice_rolls)
        .map(|bytes| bytes.to_vec())
        .map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Independent test vector, computed with Python hashlib, not this code:
    //   dice     = "123456" * 8 + "12"  (exactly 50 rolls)
    //   platform = 0x00 0x01 ... 0x1f
    //   expected = platform XOR sha256(dice_utf8)
    const VECTOR_DICE: &str = "12345612345612345612345612345612345612345612345612";
    const VECTOR_EXPECTED: [u8; 32] = [
        0xee, 0x73, 0xac, 0x92, 0x5e, 0x4b, 0x68, 0xa0, 0xc4, 0xb7, 0xb2, 0xee, 0xe9, 0xe3, 0xc0,
        0xfd, 0x8a, 0x0c, 0x1f, 0x83, 0xe4, 0x46, 0x0e, 0x20, 0x3e, 0xbd, 0x3e, 0xad, 0xcf, 0xad,
        0x6d, 0x3a,
    ];

    fn platform_fixture() -> [u8; 32] {
        core::array::from_fn(|i| i as u8)
    }

    #[test]
    fn known_vector_produces_expected_output() {
        let out = combine_entropy(&platform_fixture(), VECTOR_DICE).unwrap();
        assert_eq!(out, VECTOR_EXPECTED);
    }

    #[test]
    fn forty_nine_rolls_refuses() {
        let dice = &VECTOR_DICE[..49];
        assert_eq!(
            combine_entropy(&platform_fixture(), dice),
            Err(EntropyError::TooFewDiceRolls { got: 49 })
        );
    }

    #[test]
    fn exactly_fifty_rolls_proceeds() {
        assert!(combine_entropy(&platform_fixture(), VECTOR_DICE).is_ok());
    }

    #[test]
    fn invalid_dice_characters_refuse() {
        for bad in ["0", "7", "a", " ", "-", "\n"] {
            let dice = format!("{}{}", &VECTOR_DICE[..49], bad);
            assert_eq!(
                combine_entropy(&platform_fixture(), &dice),
                Err(EntropyError::InvalidDiceRoll),
                "accepted invalid roll {bad:?}"
            );
        }
    }

    #[test]
    fn short_platform_refuses() {
        for len in [0usize, 1, 16, 31] {
            let platform = vec![0x42u8; len];
            assert_eq!(
                combine_entropy(&platform, VECTOR_DICE),
                Err(EntropyError::PlatformWrongLength { got: len })
            );
        }
    }

    #[test]
    fn long_platform_refuses() {
        let platform = vec![0x42u8; 33];
        assert_eq!(
            combine_entropy(&platform, VECTOR_DICE),
            Err(EntropyError::PlatformWrongLength { got: 33 })
        );
    }

    #[test]
    fn all_identical_platform_bytes_refuse() {
        for byte in [0x00u8, 0xff, 0x42] {
            let platform = [byte; 32];
            assert_eq!(
                combine_entropy(&platform, VECTOR_DICE),
                Err(EntropyError::PlatformBytesAllIdentical)
            );
        }
    }

    #[test]
    fn different_dice_produce_different_output() {
        let a = combine_entropy(&platform_fixture(), VECTOR_DICE).unwrap();
        let other_dice = "65432165432165432165432165432165432165432165432165";
        let b = combine_entropy(&platform_fixture(), other_dice).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn output_differs_from_platform_input() {
        let out = combine_entropy(&platform_fixture(), VECTOR_DICE).unwrap();
        assert_ne!(out, platform_fixture());
    }

    #[test]
    fn error_messages_never_contain_source_material() {
        let err = combine_entropy(&[0x42; 31], VECTOR_DICE).unwrap_err();
        assert!(!err.to_string().contains("42"), "length error leaked byte value");
        let err = combine_entropy(&platform_fixture(), "999").unwrap_err();
        assert!(!err.to_string().contains("999"), "dice error leaked roll values");
    }
}
