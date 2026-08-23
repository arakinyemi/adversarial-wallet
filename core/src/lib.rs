pub mod btc;
pub mod entropy;

use wasm_bindgen::prelude::*;

/// Trivial boundary proof: reverses a string.
///
/// Exists only to demonstrate that data crosses the JS/WASM boundary in both
/// directions (allocation, encoding, decoding) before any real logic lives
/// here. No wallet logic belongs in this function.
#[wasm_bindgen]
pub fn round_trip(input: &str) -> String {
    input.chars().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverses_input() {
        assert_eq!(round_trip("boundary"), "yradnuob");
    }
}
