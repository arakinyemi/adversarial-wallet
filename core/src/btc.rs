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
use bitcoin::hashes::Hash;
use bitcoin::secp256k1::{Message, Secp256k1};
use bitcoin::sighash::SighashCache;
use bitcoin::{
    absolute, transaction, Address, Amount, CompressedPublicKey, EcdsaSighashType, Network,
    OutPoint, Sequence, Transaction, TxIn, TxOut, Txid, Witness,
};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

/// 32 bytes → 24 words. The only mnemonic length this wallet generates.
pub const MNEMONIC_ENTROPY_LEN: usize = 32;

#[derive(Debug, PartialEq, Eq)]
pub enum BtcError {
    EntropyWrongLength { got: usize },
    InvalidMnemonic,
    InvalidXpub,
    XpubNetworkMismatch,
    InvalidNetwork,
    InvalidAddressIndex,
    Derivation,
    InvalidRecipient,
    InvalidTxid,
    UtxoFieldsMismatched,
    AddressMismatch,
    InsufficientFunds,
    ChangeBelowDust,
    InvalidAmount,
    Signing,
}

impl core::fmt::Display for BtcError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            BtcError::EntropyWrongLength { got } => write!(
                f,
                "mnemonic entropy must be exactly {MNEMONIC_ENTROPY_LEN} bytes, got {got}"
            ),
            BtcError::InvalidMnemonic => write!(f, "invalid mnemonic"),
            BtcError::InvalidXpub => write!(f, "invalid extended public key"),
            BtcError::XpubNetworkMismatch => {
                write!(f, "this wallet was created for a different network")
            }
            BtcError::InvalidNetwork => write!(f, "network must be \"mainnet\" or \"testnet\""),
            BtcError::InvalidAddressIndex => write!(f, "address index out of range"),
            BtcError::Derivation => write!(f, "key derivation failed"),
            BtcError::InvalidRecipient => {
                write!(f, "recipient is not a valid address for this network")
            }
            BtcError::InvalidTxid => write!(f, "utxo txid is not valid"),
            BtcError::UtxoFieldsMismatched => {
                write!(f, "utxo field arrays must all have the same non-zero length")
            }
            BtcError::AddressMismatch => write!(
                f,
                "derived keys do not match the utxo addresses; wrong passphrase or mnemonic"
            ),
            BtcError::InsufficientFunds => write!(f, "utxo total is less than amount plus fee"),
            BtcError::ChangeBelowDust => write!(
                f,
                "change output would be below dust; adjust amount or fee explicitly"
            ),
            BtcError::InvalidAmount => write!(f, "amount and fee must be positive and consistent"),
            BtcError::Signing => write!(f, "transaction signing failed"),
        }
    }
}

/// Conservative dust threshold in sats; a change output below this refuses
/// rather than being silently folded into the fee.
pub const DUST_SATS: u64 = 546;

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

/// Watch-only address derivation from the account xpub alone: no seed, no
/// passphrase, no private keys anywhere in this path. chain 0 = receive,
/// chain 1 = change.
pub fn xpub_to_address(
    xpub: &str,
    network: &str,
    chain: u32,
    index: u32,
) -> Result<String, BtcError> {
    let network = parse_network(network)?;
    let parsed: Xpub = xpub.parse().map_err(|_| BtcError::InvalidXpub)?;
    if parsed.network != bitcoin::NetworkKind::from(network) {
        return Err(BtcError::XpubNetworkMismatch);
    }
    if chain > 1 {
        // BIP84 has exactly two chains: 0 receive, 1 change.
        return Err(BtcError::InvalidAddressIndex);
    }
    let path = DerivationPath::from(vec![
        ChildNumber::from_normal_idx(chain).map_err(|_| BtcError::InvalidAddressIndex)?,
        ChildNumber::from_normal_idx(index).map_err(|_| BtcError::InvalidAddressIndex)?,
    ]);
    let secp = Secp256k1::verification_only();
    let child = parsed
        .derive_pub(&secp, &path)
        .map_err(|_| BtcError::Derivation)?;
    Ok(Address::p2wpkh(&child.to_pub(), network).to_string())
}

/// Build and sign a spend of the given UTXOs. The passphrase exists only for
/// the duration of this call; the derived seed is zeroized before returning.
///
/// `utxo_addresses` is the safety interlock: for every input, the key derived
/// from (mnemonic, passphrase) at m/84'/coin'/0'/chain/index must reproduce
/// exactly the address the UTXO was found on, or nothing is signed. A wrong
/// passphrase derives a different wallet, and this check turns that into a
/// loud refusal instead of a signed-but-invalid transaction.
///
/// Change goes to m/84'/coin'/0'/1/change_index. Zero change omits the
/// output; change below dust refuses rather than silently inflating the fee.
#[allow(clippy::too_many_arguments)]
pub fn sign_spend(
    mnemonic: &str,
    passphrase: &str,
    network: &str,
    utxo_txids: &str,
    utxo_addresses: &str,
    utxo_vouts: &[u32],
    utxo_values: &[u64],
    utxo_chains: &[u32],
    utxo_indexes: &[u32],
    recipient: &str,
    amount_sats: u64,
    fee_sats: u64,
    change_index: u32,
) -> Result<String, BtcError> {
    let network = parse_network(network)?;
    if amount_sats == 0 || fee_sats == 0 {
        return Err(BtcError::InvalidAmount);
    }

    let txids: Vec<&str> = utxo_txids.lines().filter(|l| !l.is_empty()).collect();
    let addresses: Vec<&str> = utxo_addresses.lines().filter(|l| !l.is_empty()).collect();
    let n = utxo_vouts.len();
    if n == 0
        || txids.len() != n
        || addresses.len() != n
        || utxo_values.len() != n
        || utxo_chains.len() != n
        || utxo_indexes.len() != n
    {
        return Err(BtcError::UtxoFieldsMismatched);
    }

    let mut total: u64 = 0;
    for &value in utxo_values {
        total = total.checked_add(value).ok_or(BtcError::InvalidAmount)?;
    }
    let spend_total = amount_sats
        .checked_add(fee_sats)
        .ok_or(BtcError::InvalidAmount)?;
    if total < spend_total {
        return Err(BtcError::InsufficientFunds);
    }
    let change = total - spend_total;
    if change > 0 && change < DUST_SATS {
        return Err(BtcError::ChangeBelowDust);
    }

    let recipient_script = recipient
        .parse::<Address<_>>()
        .map_err(|_| BtcError::InvalidRecipient)?
        .require_network(network)
        .map_err(|_| BtcError::InvalidRecipient)?
        .script_pubkey();

    let parsed_txids: Vec<Txid> = txids
        .iter()
        .map(|t| t.parse::<Txid>().map_err(|_| BtcError::InvalidTxid))
        .collect::<Result<_, _>>()?;

    with_account_xprv(mnemonic, passphrase, network, |secp, account| {
        // Derive every input key and enforce the address interlock before
        // any signing happens.
        let mut input_keys = Vec::with_capacity(n);
        let mut input_scripts = Vec::with_capacity(n);
        for i in 0..n {
            if utxo_chains[i] > 1 {
                return Err(BtcError::InvalidAddressIndex);
            }
            let path = DerivationPath::from(vec![
                ChildNumber::from_normal_idx(utxo_chains[i])
                    .map_err(|_| BtcError::InvalidAddressIndex)?,
                ChildNumber::from_normal_idx(utxo_indexes[i])
                    .map_err(|_| BtcError::InvalidAddressIndex)?,
            ]);
            let child = account
                .derive_priv(secp, &path)
                .map_err(|_| BtcError::Derivation)?;
            let pubkey = CompressedPublicKey(child.private_key.public_key(secp));
            let derived = Address::p2wpkh(&pubkey, network);
            if derived.to_string() != addresses[i] {
                return Err(BtcError::AddressMismatch);
            }
            input_scripts.push(derived.script_pubkey());
            input_keys.push((child.private_key, pubkey));
        }

        let mut outputs = vec![TxOut {
            value: Amount::from_sat(amount_sats),
            script_pubkey: recipient_script.clone(),
        }];
        if change > 0 {
            let change_path = DerivationPath::from(vec![
                ChildNumber::from_normal_idx(1).expect("1 is in normal range"),
                ChildNumber::from_normal_idx(change_index)
                    .map_err(|_| BtcError::InvalidAddressIndex)?,
            ]);
            let change_child = account
                .derive_priv(secp, &change_path)
                .map_err(|_| BtcError::Derivation)?;
            let change_pubkey = CompressedPublicKey(change_child.private_key.public_key(secp));
            outputs.push(TxOut {
                value: Amount::from_sat(change),
                script_pubkey: Address::p2wpkh(&change_pubkey, network).script_pubkey(),
            });
        }

        let unsigned = Transaction {
            version: transaction::Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: (0..n)
                .map(|i| TxIn {
                    previous_output: OutPoint {
                        txid: parsed_txids[i],
                        vout: utxo_vouts[i],
                    },
                    script_sig: Default::default(),
                    sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                    witness: Witness::default(),
                })
                .collect(),
            output: outputs,
        };

        let mut cache = SighashCache::new(unsigned);
        for (i, (secret, pubkey)) in input_keys.iter().enumerate() {
            let sighash = cache
                .p2wpkh_signature_hash(
                    i,
                    &input_scripts[i],
                    Amount::from_sat(utxo_values[i]),
                    EcdsaSighashType::All,
                )
                .map_err(|_| BtcError::Signing)?;
            let signature = bitcoin::ecdsa::Signature {
                signature: secp.sign_ecdsa(&Message::from_digest(sighash.to_byte_array()), secret),
                sighash_type: EcdsaSighashType::All,
            };
            *cache.witness_mut(i).ok_or(BtcError::Signing)? =
                Witness::p2wpkh(&signature, &pubkey.0);
        }
        let tx = cache.into_transaction();
        Ok(bitcoin::consensus::encode::serialize_hex(&tx))
    })
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn sign_spend_js(
    mnemonic: &str,
    passphrase: &str,
    network: &str,
    utxo_txids: &str,
    utxo_addresses: &str,
    utxo_vouts: &[u32],
    utxo_values: &[u64],
    utxo_chains: &[u32],
    utxo_indexes: &[u32],
    recipient: &str,
    amount_sats: u64,
    fee_sats: u64,
    change_index: u32,
) -> Result<String, JsError> {
    sign_spend(
        mnemonic,
        passphrase,
        network,
        utxo_txids,
        utxo_addresses,
        utxo_vouts,
        utxo_values,
        utxo_chains,
        utxo_indexes,
        recipient,
        amount_sats,
        fee_sats,
        change_index,
    )
    .map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub fn xpub_to_address_js(
    xpub: &str,
    network: &str,
    chain: u32,
    index: u32,
) -> Result<String, JsError> {
    xpub_to_address(xpub, network, chain, index).map_err(|e| JsError::new(&e.to_string()))
}

/// Reverse of entropy_to_mnemonic, for wallet restore: validates the words
/// (checksum included) and returns the original 32 entropy bytes. Only
/// 24-word mnemonics are accepted — same policy as generation.
pub fn mnemonic_to_entropy(mnemonic: &str) -> Result<[u8; MNEMONIC_ENTROPY_LEN], BtcError> {
    let parsed = Mnemonic::parse_in_normalized(Language::English, mnemonic)
        .map_err(|_| BtcError::InvalidMnemonic)?;
    if parsed.word_count() != 24 {
        return Err(BtcError::InvalidMnemonic);
    }
    let (bytes, len) = parsed.to_entropy_array();
    if len != MNEMONIC_ENTROPY_LEN {
        return Err(BtcError::InvalidMnemonic);
    }
    let mut out = [0u8; MNEMONIC_ENTROPY_LEN];
    out.copy_from_slice(&bytes[..MNEMONIC_ENTROPY_LEN]);
    Ok(out)
}

#[wasm_bindgen]
pub fn mnemonic_to_entropy_js(mnemonic: &str) -> Result<Vec<u8>, JsError> {
    mnemonic_to_entropy(mnemonic)
        .map(|bytes| bytes.to_vec())
        .map_err(|e| JsError::new(&e.to_string()))
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
    fn xpub_derivation_matches_private_derivation_and_the_bip84_vectors() {
        let xpub = account_xpub(BIP84_MNEMONIC, "", "mainnet").unwrap();
        assert_eq!(xpub_to_address(&xpub, "mainnet", 0, 0).unwrap(), BIP84_ADDR_0);
        assert_eq!(xpub_to_address(&xpub, "mainnet", 0, 1).unwrap(), BIP84_ADDR_1);
        for (chain, index) in [(0u32, 7u32), (1, 0), (1, 3)] {
            // Private path takes only receive-chain indexes; compare change
            // chain against itself for determinism and difference instead.
            let a = xpub_to_address(&xpub, "mainnet", chain, index).unwrap();
            let b = xpub_to_address(&xpub, "mainnet", chain, index).unwrap();
            assert_eq!(a, b);
        }
        assert_ne!(
            xpub_to_address(&xpub, "mainnet", 1, 0).unwrap(),
            xpub_to_address(&xpub, "mainnet", 0, 0).unwrap(),
            "change and receive chains must differ"
        );
    }

    #[test]
    fn xpub_network_mismatch_refuses() {
        let tpub = account_xpub(BIP84_MNEMONIC, "", "testnet").unwrap();
        assert_eq!(
            xpub_to_address(&tpub, "mainnet", 0, 0),
            Err(BtcError::XpubNetworkMismatch)
        );
        let xpub = account_xpub(BIP84_MNEMONIC, "", "mainnet").unwrap();
        assert_eq!(
            xpub_to_address(&xpub, "testnet", 0, 0),
            Err(BtcError::XpubNetworkMismatch)
        );
    }

    #[test]
    fn xpub_invalid_inputs_refuse() {
        assert_eq!(
            xpub_to_address("not an xpub", "mainnet", 0, 0),
            Err(BtcError::InvalidXpub)
        );
        let xpub = account_xpub(BIP84_MNEMONIC, "", "mainnet").unwrap();
        // only chains 0 (receive) and 1 (change) exist in BIP84
        assert_eq!(
            xpub_to_address(&xpub, "mainnet", 2, 0),
            Err(BtcError::InvalidAddressIndex)
        );
        assert_eq!(
            xpub_to_address(&xpub, "mainnet", 0, 0x8000_0000),
            Err(BtcError::InvalidAddressIndex)
        );
    }

    #[test]
    fn mnemonic_round_trips_back_to_its_entropy() {
        assert_eq!(
            mnemonic_to_entropy(ZERO_ENTROPY_MNEMONIC).unwrap(),
            [0u8; 32]
        );
        let entropy: [u8; 32] = core::array::from_fn(|i| (i * 3 + 1) as u8);
        let words = entropy_to_mnemonic(&entropy).unwrap().to_string();
        assert_eq!(mnemonic_to_entropy(&words).unwrap(), entropy);
    }

    #[test]
    fn restore_refuses_non_24_word_and_invalid_mnemonics() {
        // Valid 12-word BIP39, still refused: only 24-word seeds exist here.
        assert_eq!(
            mnemonic_to_entropy(BIP84_MNEMONIC),
            Err(BtcError::InvalidMnemonic)
        );
        assert_eq!(
            mnemonic_to_entropy("abandon abandon zebra"),
            Err(BtcError::InvalidMnemonic)
        );
        let bad_checksum = format!("{} abandon", &ZERO_ENTROPY_MNEMONIC[..ZERO_ENTROPY_MNEMONIC.len() - 4]);
        assert_eq!(
            mnemonic_to_entropy(&bad_checksum),
            Err(BtcError::InvalidMnemonic)
        );
    }

    // --- sign_spend ------------------------------------------------------

    const TXID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn test_only_hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn addr0() -> String {
        derive_address(BIP84_MNEMONIC, "", "mainnet", 0).unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn spend(
        passphrase: &str,
        value: u64,
        amount: u64,
        fee: u64,
    ) -> Result<String, BtcError> {
        sign_spend(
            BIP84_MNEMONIC,
            passphrase,
            "mainnet",
            TXID_A,
            &addr0(),
            &[0],
            &[value],
            &[0],
            &[0],
            BIP84_ADDR_1,
            amount,
            fee,
            0,
        )
    }

    #[test]
    fn signing_is_deterministic_and_produces_the_requested_outputs() {
        let hex1 = spend("", 100_000, 40_000, 1_000).unwrap();
        let hex2 = spend("", 100_000, 40_000, 1_000).unwrap();
        assert_eq!(hex1, hex2, "RFC6979 signing must be deterministic");

        let tx: bitcoin::Transaction =
            bitcoin::consensus::encode::deserialize(&test_only_hex_to_bytes(&hex1)).unwrap();
        assert_eq!(tx.input.len(), 1);
        assert_eq!(tx.input[0].previous_output.txid.to_string(), TXID_A);
        assert_eq!(tx.input[0].previous_output.vout, 0);
        let witness = &tx.input[0].witness;
        assert_eq!(witness.len(), 2, "p2wpkh witness is [signature, pubkey]");
        assert_eq!(witness.iter().nth(1).unwrap().len(), 33);

        let recipient_script = BIP84_ADDR_1
            .parse::<bitcoin::Address<_>>()
            .unwrap()
            .assume_checked()
            .script_pubkey();
        let xpub = account_xpub(BIP84_MNEMONIC, "", "mainnet").unwrap();
        let change_script = xpub_to_address(&xpub, "mainnet", 1, 0)
            .unwrap()
            .parse::<bitcoin::Address<_>>()
            .unwrap()
            .assume_checked()
            .script_pubkey();
        assert_eq!(tx.output.len(), 2);
        let find = |script: &bitcoin::ScriptBuf| {
            tx.output
                .iter()
                .find(|o| &o.script_pubkey == script)
                .map(|o| o.value.to_sat())
        };
        assert_eq!(find(&recipient_script), Some(40_000));
        assert_eq!(find(&change_script), Some(59_000));
    }

    #[test]
    fn exact_spend_has_no_change_output() {
        let hex = spend("", 100_000, 99_000, 1_000).unwrap();
        let tx: bitcoin::Transaction =
            bitcoin::consensus::encode::deserialize(&test_only_hex_to_bytes(&hex)).unwrap();
        assert_eq!(tx.output.len(), 1);
    }

    #[test]
    fn wrong_passphrase_refuses_before_signing_anything() {
        // The UTXO lives on the empty-passphrase wallet's address; a
        // passphrase-bearing derivation must refuse, not sign garbage.
        assert_eq!(
            spend("TREZOR", 100_000, 40_000, 1_000),
            Err(BtcError::AddressMismatch)
        );
    }

    #[test]
    fn insufficient_funds_refuse() {
        assert_eq!(
            spend("", 100_000, 100_000, 1_000),
            Err(BtcError::InsufficientFunds)
        );
    }

    #[test]
    fn change_below_dust_refuses() {
        assert_eq!(
            spend("", 100_000, 98_900, 1_000),
            Err(BtcError::ChangeBelowDust)
        );
    }

    #[test]
    fn zero_amount_or_fee_refuses() {
        assert_eq!(spend("", 100_000, 0, 1_000), Err(BtcError::InvalidAmount));
        assert_eq!(spend("", 100_000, 40_000, 0), Err(BtcError::InvalidAmount));
    }

    #[test]
    fn value_overflow_refuses() {
        assert_eq!(
            sign_spend(
                BIP84_MNEMONIC,
                "",
                "mainnet",
                &format!("{TXID_A}\n{TXID_A}"),
                &format!("{}\n{}", addr0(), addr0()),
                &[0, 1],
                &[u64::MAX, 1_000],
                &[0, 0],
                &[0, 0],
                BIP84_ADDR_1,
                40_000,
                1_000,
                0,
            ),
            Err(BtcError::InvalidAmount)
        );
    }

    #[test]
    fn mismatched_utxo_arrays_refuse() {
        assert_eq!(
            sign_spend(
                BIP84_MNEMONIC,
                "",
                "mainnet",
                TXID_A,
                &addr0(),
                &[0, 1],
                &[100_000],
                &[0],
                &[0],
                BIP84_ADDR_1,
                40_000,
                1_000,
                0,
            ),
            Err(BtcError::UtxoFieldsMismatched)
        );
        assert_eq!(
            sign_spend(
                BIP84_MNEMONIC,
                "",
                "mainnet",
                "",
                "",
                &[],
                &[],
                &[],
                &[],
                BIP84_ADDR_1,
                40_000,
                1_000,
                0,
            ),
            Err(BtcError::UtxoFieldsMismatched)
        );
    }

    #[test]
    fn wrong_network_recipient_refuses() {
        let tpub = account_xpub(BIP84_MNEMONIC, "", "testnet").unwrap();
        let testnet_recipient = xpub_to_address(&tpub, "testnet", 0, 0).unwrap();
        assert_eq!(
            sign_spend(
                BIP84_MNEMONIC,
                "",
                "mainnet",
                TXID_A,
                &addr0(),
                &[0],
                &[100_000],
                &[0],
                &[0],
                &testnet_recipient,
                40_000,
                1_000,
                0,
            ),
            Err(BtcError::InvalidRecipient)
        );
        assert_eq!(spend("", 100_000, 40_000, 1_000).is_ok(), true);
    }

    #[test]
    fn invalid_txid_refuses() {
        assert_eq!(
            sign_spend(
                BIP84_MNEMONIC,
                "",
                "mainnet",
                "zz",
                &addr0(),
                &[0],
                &[100_000],
                &[0],
                &[0],
                BIP84_ADDR_1,
                40_000,
                1_000,
                0,
            ),
            Err(BtcError::InvalidTxid)
        );
    }

    #[test]
    fn error_messages_never_echo_mnemonic_words() {
        let err = derive_address("abandon abandon zebra", "", "mainnet", 0).unwrap_err();
        let msg = err.to_string();
        assert!(!msg.contains("abandon") && !msg.contains("zebra"));
    }
}
