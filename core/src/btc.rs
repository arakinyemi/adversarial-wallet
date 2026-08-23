//! Bitcoin key derivation. See PLAN.md §5.
//!
//! BIP39 (24 words, from the entropy module's 32 verified bytes) with an
//! optional BIP39 passphrase, then BIP84 native segwit derivation
//! (m/84'/coin'/0'/0/index).
//!
//! The passphrase is a per-call argument. It is never stored, never cached,
//! and never part of any struct. A seed without the passphrase derives a
//! completely different (and empty) wallet — that is the security model, so
//! nothing in this module may weaken it: no passphrase defaults, no
//! remembered last value, no fallback derivation.
//!
//! Error messages name the failed check and never echo mnemonic words,
//! passphrases, or key bytes.

use bip39::{Language, Mnemonic};
use bitcoin::bip32::{ChildNumber, DerivationPath, Xpriv, Xpub};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::{Address, CompressedPublicKey, Network};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

/// 32 bytes → 24 words. The only mnemonic length this wallet generates.
pub const MNEMONIC_ENTROPY_LEN: usize = 32;

#[derive(Debug, PartialEq, Eq)]
pub enum BtcError {
    EntropyWrongLength { got: usize },
    InvalidMnemonic,
    InvalidNetwork,
    InvalidAddressIndex,
    Derivation,
}

impl core::fmt::Display for BtcError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            BtcError::EntropyWrongLength { got } => write!(
                f,
                "mnemonic entropy must be exactly {MNEMONIC_ENTROPY_LEN} bytes, got {got}"
            ),
            BtcError::InvalidMnemonic => write!(f, "invalid mnemonic"),
            BtcError::InvalidNetwork => write!(f, "network must be \"mainnet\" or \"testnet\""),
            BtcError::InvalidAddressIndex => write!(f, "address index out of range"),
            BtcError::Derivation => write!(f, "key derivation failed"),
        }
    }
}

/// 32 verified entropy bytes → 24-word BIP39 mnemonic.
pub fn entropy_to_mnemonic(entropy: &[u8]) -> Result<Mnemonic, BtcError> {
    if entropy.len() != MNEMONIC_ENTROPY_LEN {
        return Err(BtcError::EntropyWrongLength { got: entropy.len() });
    }
    Mnemonic::from_entropy_in(Language::English, entropy).map_err(|_| BtcError::InvalidMnemonic)
}

fn parse_network(network: &str) -> Result<Network, BtcError> {
    match network {
        "mainnet" => Ok(Network::Bitcoin),
        "testnet" => Ok(Network::Testnet),
        _ => Err(BtcError::InvalidNetwork),
    }
}

fn coin_type(network: Network) -> u32 {
    match network {
        Network::Bitcoin => 0,
        _ => 1,
    }
}

/// Derive the account xprv at m/84'/coin'/0' and hand it to `f`.
/// The BIP39 seed is zeroized before returning; the xprv itself lives only
/// inside this call. (WASM linear memory is JS-readable either way — this is
/// residue reduction, not isolation. See LIMITATIONS.md.)
fn with_account_xprv<T>(
    mnemonic: &str,
    passphrase: &str,
    network: Network,
    f: impl FnOnce(&Secp256k1<bitcoin::secp256k1::All>, &Xpriv) -> Result<T, BtcError>,
) -> Result<T, BtcError> {
    let parsed = Mnemonic::parse_in_normalized(Language::English, mnemonic)
        .map_err(|_| BtcError::InvalidMnemonic)?;
    let mut seed = parsed.to_seed_normalized(passphrase);
    let master = Xpriv::new_master(network, &seed);
    seed.zeroize();
    let master = master.map_err(|_| BtcError::Derivation)?;

    let account_path = DerivationPath::from(vec![
        ChildNumber::from_hardened_idx(84).expect("84 is in hardened range"),
        ChildNumber::from_hardened_idx(coin_type(network)).expect("0/1 is in hardened range"),
        ChildNumber::from_hardened_idx(0).expect("0 is in hardened range"),
    ]);
    let secp = Secp256k1::new();
    let account = master
        .derive_priv(&secp, &account_path)
        .map_err(|_| BtcError::Derivation)?;
    f(&secp, &account)
}

/// BIP84 receive address at m/84'/coin'/0'/0/index.
pub fn derive_address(
    mnemonic: &str,
    passphrase: &str,
    network: &str,
    index: u32,
) -> Result<String, BtcError> {
    let network = parse_network(network)?;
    let child = ChildNumber::from_normal_idx(index).map_err(|_| BtcError::InvalidAddressIndex)?;
    with_account_xprv(mnemonic, passphrase, network, |secp, account| {
        let receive_path = DerivationPath::from(vec![
            ChildNumber::from_normal_idx(0).expect("0 is in normal range"),
            child,
        ]);
        let xprv = account
            .derive_priv(secp, &receive_path)
            .map_err(|_| BtcError::Derivation)?;
        let pubkey = CompressedPublicKey(xprv.private_key.public_key(secp));
        Ok(Address::p2wpkh(&pubkey, network).to_string())
    })
}

/// Account-level extended public key at m/84'/coin'/0', for watch-only use.
pub fn account_xpub(
    mnemonic: &str,
    passphrase: &str,
    network: &str,
) -> Result<String, BtcError> {
    let network = parse_network(network)?;
    with_account_xprv(mnemonic, passphrase, network, |secp, account| {
        Ok(Xpub::from_priv(secp, account).to_string())
    })
}

#[wasm_bindgen]
pub fn entropy_to_mnemonic_js(entropy: &[u8]) -> Result<String, JsError> {
    entropy_to_mnemonic(entropy)
        .map(|m| m.to_string())
        .map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub fn derive_address_js(
    mnemonic: &str,
    passphrase: &str,
    network: &str,
    index: u32,
) -> Result<String, JsError> {
    derive_address(mnemonic, passphrase, network, index).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub fn account_xpub_js(
    mnemonic: &str,
    passphrase: &str,
    network: &str,
) -> Result<String, JsError> {
    account_xpub(mnemonic, passphrase, network).map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Public reference vectors only — never real key material.
    // BIP39 Trezor vector: 32 zero bytes of entropy.
    const ZERO_ENTROPY_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
    // BIP84 reference mnemonic and its first two receive addresses
    // (m/84'/0'/0'/0/0 and /0/1, empty passphrase), from the BIP84 spec.
    const BIP84_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const BIP84_ADDR_0: &str = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
    const BIP84_ADDR_1: &str = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";

    #[test]
    fn zero_entropy_derives_the_reference_24_words() {
        let m = entropy_to_mnemonic(&[0u8; 32]).unwrap();
        assert_eq!(m.to_string(), ZERO_ENTROPY_MNEMONIC);
        assert_eq!(m.word_count(), 24);
    }

    #[test]
    fn wrong_entropy_lengths_refuse_including_valid_bip39_shorter_ones() {
        // 16 bytes would be a valid 12-word BIP39 input; this wallet still
        // refuses it — only 24-word seeds exist here.
        for len in [0usize, 16, 31, 33] {
            assert_eq!(
                entropy_to_mnemonic(&vec![7u8; len]),
                Err(BtcError::EntropyWrongLength { got: len })
            );
        }
    }

    #[test]
    fn bip84_reference_addresses_derive_exactly() {
        assert_eq!(
            derive_address(BIP84_MNEMONIC, "", "mainnet", 0).unwrap(),
            BIP84_ADDR_0
        );
        assert_eq!(
            derive_address(BIP84_MNEMONIC, "", "mainnet", 1).unwrap(),
            BIP84_ADDR_1
        );
    }

    #[test]
    fn passphrase_changes_the_derived_address() {
        let without = derive_address(BIP84_MNEMONIC, "", "mainnet", 0).unwrap();
        let with = derive_address(BIP84_MNEMONIC, "TREZOR", "mainnet", 0).unwrap();
        assert_ne!(without, with);
        assert_eq!(without, BIP84_ADDR_0);
        assert!(with.starts_with("bc1q"));
    }

    #[test]
    fn different_passphrases_derive_different_addresses() {
        let a = derive_address(BIP84_MNEMONIC, "TREZOR", "mainnet", 0).unwrap();
        let b = derive_address(BIP84_MNEMONIC, "trezor", "mainnet", 0).unwrap();
        assert_ne!(a, b, "passphrase must be case-sensitive");
    }

    #[test]
    fn derivation_is_deterministic() {
        let a = derive_address(BIP84_MNEMONIC, "x y z", "mainnet", 5).unwrap();
        let b = derive_address(BIP84_MNEMONIC, "x y z", "mainnet", 5).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn testnet_addresses_have_testnet_prefix_and_differ_from_mainnet() {
        let t = derive_address(BIP84_MNEMONIC, "", "testnet", 0).unwrap();
        assert!(t.starts_with("tb1q"));
        assert_ne!(t, BIP84_ADDR_0);
    }

    #[test]
    fn unknown_network_refuses() {
        assert_eq!(
            derive_address(BIP84_MNEMONIC, "", "signet", 0),
            Err(BtcError::InvalidNetwork)
        );
    }

    #[test]
    fn invalid_mnemonics_refuse() {
        let bad_checksum = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
        assert_eq!(
            derive_address(bad_checksum, "", "mainnet", 0),
            Err(BtcError::InvalidMnemonic)
        );
        assert_eq!(
            derive_address("definitely not a mnemonic", "", "mainnet", 0),
            Err(BtcError::InvalidMnemonic)
        );
    }

    #[test]
    fn hardened_range_address_index_refuses() {
        assert_eq!(
            derive_address(BIP84_MNEMONIC, "", "mainnet", 0x8000_0000),
            Err(BtcError::InvalidAddressIndex)
        );
    }

    #[test]
    fn account_xpub_prefixes_and_passphrase_sensitivity() {
        let main = account_xpub(BIP84_MNEMONIC, "", "mainnet").unwrap();
        assert!(main.starts_with("xpub"));
        let test = account_xpub(BIP84_MNEMONIC, "", "testnet").unwrap();
        assert!(test.starts_with("tpub"));
        let with_pass = account_xpub(BIP84_MNEMONIC, "TREZOR", "mainnet").unwrap();
        assert_ne!(main, with_pass);
        assert_eq!(main, account_xpub(BIP84_MNEMONIC, "", "mainnet").unwrap());
    }

    #[test]
    fn error_messages_never_echo_mnemonic_words() {
        let err = derive_address("abandon abandon zebra", "", "mainnet", 0).unwrap_err();
        let msg = err.to_string();
        assert!(!msg.contains("abandon") && !msg.contains("zebra"));
    }
}
