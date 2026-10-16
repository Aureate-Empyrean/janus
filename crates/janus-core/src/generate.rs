//! Password generation from the operating system's CSPRNG, without modulo bias.

use crate::{Error, Result};
use zeroize::Zeroizing;

const LOWER: &str = "abcdefghijkmnopqrstuvwxyz";
const UPPER: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS: &str = "23456789";
const SYMBOLS: &str = "!#$%&*+-=?@^_~";

/// Generates a password of `length` characters (16–128) using letters, digits and,
/// optionally, symbols. Look-alike characters (0/O, 1/l/I) are excluded.
pub fn generate_password(length: usize, symbols: bool) -> Result<Zeroizing<String>> {
    if !(16..=128).contains(&length) {
        return Err(Error::Format("password length must be 16–128".into()));
    }
    let mut alphabet: Vec<char> = [LOWER, UPPER, DIGITS].concat().chars().collect();
    if symbols {
        alphabet.extend(SYMBOLS.chars());
    }
    let mut out = Zeroizing::new(String::with_capacity(length));
    // Largest multiple of the alphabet size below 256: reject bytes above it.
    let limit = 256 - (256 % alphabet.len());
    let mut buf = [0u8; 64];
    while out.chars().count() < length {
        getrandom::fill(&mut buf).map_err(|_| Error::Crypto)?;
        for &b in &buf {
            if (b as usize) < limit && out.chars().count() < length {
                out.push(alphabet[b as usize % alphabet.len()]);
            }
        }
    }
    buf.fill(0);
    Ok(out)
}

/// Entropy in bits of a password generated with these settings.
pub fn generated_entropy_bits(length: usize, symbols: bool) -> f64 {
    let size = LOWER.len() + UPPER.len() + DIGITS.len() + if symbols { SYMBOLS.len() } else { 0 };
    length as f64 * (size as f64).log2()
}
