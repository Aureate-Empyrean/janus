//! Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP), generated locally.
//!
//! Accepts a bare Base32 key (spaces and lowercase allowed) or an `otpauth://totp/` link.

use crate::{Error, Result};
use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, KeyInit, Mac};
use serde::Serialize;
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

/// Parsed authenticator settings. The key is zeroized on drop.
pub struct Totp {
    key: Zeroizing<Vec<u8>>,
    pub algorithm: Algorithm,
    pub digits: u32,
    pub period: u64,
}

/// A code valid now, and for how many more seconds.
#[derive(Clone, Debug, Serialize)]
pub struct TotpCode {
    pub code: String,
    pub remaining: u64,
    pub period: u64,
}

impl Totp {
    pub fn parse(input: &str) -> Result<Self> {
        let invalid = || {
            Error::Invalid("authenticator key is not a valid Base32 key or otpauth:// link".into())
        };
        let input = input.trim();
        let (secret, mut algorithm, mut digits, mut period) =
            (input.to_owned(), Algorithm::Sha1, 6, 30);
        let mut secret = Zeroizing::new(secret);
        if let Some(rest) = input.strip_prefix("otpauth://") {
            let (kind, rest) = rest.split_once('/').ok_or_else(invalid)?;
            if !kind.eq_ignore_ascii_case("totp") {
                return Err(Error::Invalid(
                    "only time-based (TOTP) authenticators are supported".into(),
                ));
            }
            let query = rest.split_once('?').map(|(_, q)| q).ok_or_else(invalid)?;
            secret = Zeroizing::new(String::new());
            for pair in query.split('&') {
                let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                let value = percent_decode(value);
                match key.to_ascii_lowercase().as_str() {
                    "secret" => secret = Zeroizing::new(value),
                    "algorithm" => {
                        algorithm = match value.to_ascii_uppercase().as_str() {
                            "SHA1" => Algorithm::Sha1,
                            "SHA256" => Algorithm::Sha256,
                            "SHA512" => Algorithm::Sha512,
                            _ => return Err(invalid()),
                        }
                    }
                    "digits" => digits = value.parse().map_err(|_| invalid())?,
                    "period" => period = value.parse().map_err(|_| invalid())?,
                    _ => {}
                }
            }
        }
        if !(6..=8).contains(&digits) || !(1..=300).contains(&period) {
            return Err(invalid());
        }
        let normalized: String = secret
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
            .map(|c| c.to_ascii_uppercase())
            .collect();
        let normalized = Zeroizing::new(normalized);
        let key = Zeroizing::new(
            BASE32_NOPAD
                .decode(normalized.as_bytes())
                .map_err(|_| invalid())?,
        );
        if key.len() < 10 {
            return Err(Error::Invalid("authenticator key is too short".into()));
        }
        Ok(Self {
            key,
            algorithm,
            digits,
            period,
        })
    }

    /// Code for a Unix time in seconds.
    pub fn at(&self, unix: u64) -> TotpCode {
        let counter = (unix / self.period).to_be_bytes();
        let digest = match self.algorithm {
            Algorithm::Sha1 => mac::<Hmac<sha1::Sha1>>(&self.key, &counter),
            Algorithm::Sha256 => mac::<Hmac<sha2::Sha256>>(&self.key, &counter),
            Algorithm::Sha512 => mac::<Hmac<sha2::Sha512>>(&self.key, &counter),
        };
        // RFC 4226 dynamic truncation.
        let offset = (digest[digest.len() - 1] & 0x0f) as usize;
        let binary = u32::from_be_bytes([
            digest[offset] & 0x7f,
            digest[offset + 1],
            digest[offset + 2],
            digest[offset + 3],
        ]);
        let code = binary % 10u32.pow(self.digits);
        TotpCode {
            code: format!("{code:0width$}", width = self.digits as usize),
            remaining: self.period - unix % self.period,
            period: self.period,
        }
    }

    pub fn now(&self) -> TotpCode {
        let unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.at(unix)
    }
}

fn mac<M: Mac + KeyInit>(key: &[u8], message: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut mac = <M as KeyInit>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message);
    Zeroizing::new(mac.finalize().into_bytes().to_vec())
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
                continue;
            }
            (b'+', _) => out.push(b' '),
            (b, _) => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 appendix B: ASCII keys "12345678901234567890" repeated to the hash size.
    const SHA1_KEY: &[u8] = b"12345678901234567890";
    const SHA256_KEY: &[u8] = b"12345678901234567890123456789012";
    const SHA512_KEY: &[u8] = b"1234567890123456789012345678901234567890123456789012345678901234";

    fn uri(key: &[u8], algorithm: &str) -> String {
        format!(
            "otpauth://totp/Example:alice?secret={}&algorithm={algorithm}&digits=8&period=30",
            BASE32_NOPAD.encode(key)
        )
    }

    #[test]
    fn rfc6238_vectors() {
        let cases: [(u64, &str, &str, &str); 6] = [
            (59, "94287082", "46119246", "90693936"),
            (1111111109, "07081804", "68084774", "25091201"),
            (1111111111, "14050471", "67062674", "99943326"),
            (1234567890, "89005924", "91819424", "93441116"),
            (2000000000, "69279037", "90698825", "38618901"),
            (20000000000, "65353130", "77737706", "47863826"),
        ];
        let sha1 = Totp::parse(&uri(SHA1_KEY, "SHA1")).unwrap();
        let sha256 = Totp::parse(&uri(SHA256_KEY, "SHA256")).unwrap();
        let sha512 = Totp::parse(&uri(SHA512_KEY, "SHA512")).unwrap();
        for (t, a, b, c) in cases {
            assert_eq!(sha1.at(t).code, a, "SHA1 at {t}");
            assert_eq!(sha256.at(t).code, b, "SHA256 at {t}");
            assert_eq!(sha512.at(t).code, c, "SHA512 at {t}");
        }
    }

    #[test]
    fn bare_keys_defaults_and_rejections() {
        let key = BASE32_NOPAD.encode(SHA1_KEY).to_lowercase();
        let spaced: String = key
            .chars()
            .collect::<Vec<_>>()
            .chunks(4)
            .map(|c| c.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join(" ");
        let totp = Totp::parse(&spaced).unwrap();
        assert_eq!(
            (totp.digits, totp.period, totp.algorithm),
            (6, 30, Algorithm::Sha1)
        );
        let code = totp.at(59);
        assert_eq!((code.code.as_str(), code.remaining), ("287082", 1));
        assert!(Totp::parse("not base32 !!").is_err());
        assert!(Totp::parse("AAAA").is_err()); // too short
        assert!(Totp::parse("otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").is_err());
        assert!(
            Totp::parse("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=4")
                .is_err()
        );
        let encoded = Totp::parse(
            "otpauth://totp/A%20B?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=A%20B",
        )
        .unwrap();
        assert_eq!(encoded.at(59).code, "287082");
    }
}
