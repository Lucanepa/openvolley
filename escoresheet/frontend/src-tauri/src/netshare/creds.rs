//! The tablet Wi-Fi's name and password.
//!
//! Made so they survive every system in between: the Wi-Fi QR code (no
//! character needs escaping, so no camera parser can get it wrong), Windows
//! (the SSID is encoded in the system code page: ASCII only) and WPA2 (8-63
//! printable characters; exactly 64 would be read as a raw hex key).

// rand 0.10: `Rng` is the generator trait (was `RngCore`) and `RngExt` holds
// `random_range` (was `Rng`).
use rand::{Rng, RngExt};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub ssid: String,
    pub password: String,
}

pub const SSID_PREFIX: &str = crate::flavour::CURRENT.ssid_prefix;
/// No 0/O, 1/I/L: read off a screen and typed on a tablet.
const SSID_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PASSWORD_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const PASSWORD_LEN: usize = 12;

fn pick(rng: &mut impl Rng, alphabet: &[u8], n: usize) -> String {
    (0..n).map(|_| alphabet[rng.random_range(0..alphabet.len())] as char).collect()
}

/// The OS random source as an infallible `Rng`: `SysRng` is getrandom's
/// stateless interface to the system CSPRNG (rand 0.9's `OsRng`, renamed in
/// 0.10; nothing to seed) and `UnwrapErr` panics if it ever fails (0.9's
/// `OsRng.unwrap_err()`), so a failure is never replaced by weaker randomness.
/// The concrete type is spelled out so a test pins it.
fn os_rng() -> rand::rand_core::UnwrapErr<rand::rngs::SysRng> {
    rand::rand_core::UnwrapErr(rand::rngs::SysRng)
}

/// A fresh name and password from the OS random source.
pub fn generate() -> Credentials {
    generate_with(&mut os_rng())
}

pub fn generate_with(rng: &mut impl Rng) -> Credentials {
    let ssid = format!("{SSID_PREFIX}{}", pick(rng, SSID_ALPHABET, 4));
    let password = loop {
        let p = pick(rng, PASSWORD_ALPHABET, PASSWORD_LEN);
        // at least one letter beyond a-f: never mistaken for a hex key
        if p.chars().any(|c| c.is_ascii_alphabetic() && !c.is_ascii_hexdigit()) {
            break p;
        }
    };
    Credentials { ssid, password }
}

/// Network name: 1-32 characters of letters, digits, space, `-`, `_`, `.`,
/// not starting or ending with a space.
pub fn check_ssid(ssid: &str) -> Result<(), String> {
    if ssid.is_empty() || ssid.len() > 32 {
        return Err("the network name must have 1 to 32 characters".into());
    }
    if ssid.starts_with(' ') || ssid.ends_with(' ') {
        return Err("the network name must not start or end with a space".into());
    }
    if !ssid.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.')) {
        return Err("the network name may only use letters, digits, space, - _ .".into());
    }
    Ok(())
}

/// WPA2 passphrase: 8-63 printable ASCII characters.
pub fn check_password(password: &str) -> Result<(), String> {
    let n = password.chars().count();
    if !(8..=63).contains(&n) {
        return Err("the password must have 8 to 63 characters".into());
    }
    if !password.chars().all(|c| (' '..='~').contains(&c)) {
        return Err("the password may only use printable ASCII characters".into());
    }
    Ok(())
}

impl Credentials {
    pub fn checked(ssid: &str, password: &str) -> Result<Self, String> {
        check_ssid(ssid)?;
        check_password(password)?;
        Ok(Self { ssid: ssid.to_string(), password: password.to_string() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn generated_credentials_are_valid_and_qr_safe() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        for _ in 0..500 {
            let c = generate_with(&mut rng);
            assert!(c.ssid.starts_with(SSID_PREFIX), "{}", c.ssid);
            assert_eq!(c.ssid.len(), SSID_PREFIX.len() + 4);
            assert_eq!(c.password.len(), PASSWORD_LEN);
            Credentials::checked(&c.ssid, &c.password).expect("valid");
            // nothing the Wi-Fi QR format would have to escape
            for ch in c.ssid.chars().chain(c.password.chars()) {
                assert!(!matches!(ch, '\\' | ';' | ',' | ':' | '"'), "{ch}");
            }
            assert!(c.password.chars().any(|ch| ch.is_ascii_alphabetic() && !ch.is_ascii_hexdigit()));
            for ambiguous in ['0', 'O', '1', 'I', 'l'] {
                assert!(!c.password.contains(ambiguous) && !c.ssid[SSID_PREFIX.len()..].contains(ambiguous));
            }
        }
        // the OS source works and differs between calls
        assert_ne!(generate(), generate());
    }

    #[test]
    fn generate_draws_from_the_os_source() {
        // generate() uses getrandom's SysRng (the system CSPRNG), never a
        // seeded or thread-local generator: this stops compiling if os_rng()
        // returns anything else
        fn system_csprng(_: &rand::rand_core::UnwrapErr<rand::rngs::SysRng>) {}
        fn crypto_rng(_: &impl rand::CryptoRng) {}
        let rng = os_rng();
        system_csprng(&rng);
        crypto_rng(&rng);

        // at least 64 bits per password: 12 symbols of 55 (~69 bits)
        let bits = PASSWORD_LEN as f64 * (PASSWORD_ALPHABET.len() as f64).log2();
        assert!(bits >= 64.0, "{bits}");

        // 2000 passwords from the OS source: valid, all different, only the
        // alphabet's symbols and every one of them (24000 draws of 55: a
        // missing symbol has a chance of about 1e-190)
        let mut seen_passwords = std::collections::HashSet::new();
        let mut seen_symbols = std::collections::HashSet::new();
        let mut seen_ssid_symbols = std::collections::HashSet::new();
        for _ in 0..2000 {
            let c = generate();
            Credentials::checked(&c.ssid, &c.password).expect("valid");
            assert_eq!(c.password.len(), PASSWORD_LEN);
            assert!(c.password.bytes().all(|b| PASSWORD_ALPHABET.contains(&b)), "{}", c.password);
            let suffix = &c.ssid[SSID_PREFIX.len()..];
            assert_eq!(suffix.len(), 4);
            assert!(suffix.bytes().all(|b| SSID_ALPHABET.contains(&b)), "{}", c.ssid);
            seen_symbols.extend(c.password.bytes());
            seen_ssid_symbols.extend(suffix.bytes());
            assert!(seen_passwords.insert(c.password));
        }
        assert_eq!(seen_symbols.len(), PASSWORD_ALPHABET.len());
        assert_eq!(seen_ssid_symbols.len(), SSID_ALPHABET.len());
    }

    #[test]
    fn checks_names_and_passwords() {
        assert!(check_ssid("OpenVolley-AB12").is_ok());
        assert!(check_ssid("Halle 3_court.1").is_ok());
        assert!(check_ssid("").is_err());
        assert!(check_ssid(&"x".repeat(33)).is_err());
        assert!(check_ssid(" lead").is_err());
        assert!(check_ssid("trail ").is_err());
        assert!(check_ssid("semi;colon").is_err());
        assert!(check_ssid("Turnhalle-Zürich").is_err());
        assert!(check_ssid("quote\"").is_err());
        assert!(check_ssid("$(reboot)").is_err());

        assert!(check_password("abcdefgh").is_ok());
        assert!(check_password("with spaces and ;:,\"\\").is_ok());
        assert!(check_password("short").is_err());
        assert!(check_password(&"a".repeat(64)).is_err());
        assert!(check_password(&"a".repeat(63)).is_ok());
        assert!(check_password("tab\there!").is_err());
        assert!(check_password("passwört1").is_err());
        assert!(Credentials::checked("OpenVolley-AB12", "x").is_err());
    }
}
