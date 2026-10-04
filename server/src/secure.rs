//! Шифрування того, що лежить на диску, засобами Windows (DPAPI, CryptProtectData): розшифрувати може лише той самий
//! користувач Windows. `entropy` — додатковий «ключ» для кожного виду даних: паролі сайтів і сеанс облікового запису
//! інша програма того самого користувача не розшифрує, не знаючи його.
//!
//! Тут же — наскрізне шифрування для синхронізації: ключ виводиться з пароля облікового запису (PBKDF2), тож сервер
//! бачить лише зашифроване, а розшифрувати може тільки той, хто знає пароль.

use windows::Win32::{
  Foundation::{LocalFree, HLOCAL},
  Security::Cryptography::{
    BCryptCloseAlgorithmProvider, BCryptDeriveKeyPBKDF2, BCryptGenRandom, BCryptOpenAlgorithmProvider, CryptProtectData,
    CryptUnprotectData, BCRYPT_ALG_HANDLE, BCRYPT_ALG_HANDLE_HMAC_FLAG, BCRYPT_SHA256_ALGORITHM,
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
  },
};
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use windows_core::PCWSTR;

/// Ключ синхронізації (AES-256).
pub type SyncKey = [u8; 32];

/// Раунди PBKDF2-HMAC-SHA256 — як радить OWASP: підбирати пароль до вкраденого шифру так довго, як тільки можна.
const PBKDF2_ROUNDS: u64 = 600_000;

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
  CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr().cast_mut() }
}

/// Копіює й звільняє буфер, який виділив DPAPI.
fn take_blob(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
  if output.pbData.is_null() {
    return Vec::new();
  }
  let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
  unsafe { LocalFree(Some(HLOCAL(output.pbData.cast()))) };
  bytes
}

pub fn protect(data: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
  let mut output = CRYPT_INTEGER_BLOB::default();
  unsafe { CryptProtectData(&blob(data), PCWSTR::null(), Some(&blob(entropy)), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
    .map_err(|error| error.to_string())?;
  Ok(take_blob(output))
}

pub fn unprotect(data: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
  let mut output = CRYPT_INTEGER_BLOB::default();
  unsafe { CryptUnprotectData(&blob(data), None, Some(&blob(entropy)), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
    .map_err(|error| error.to_string())?;
  Ok(take_blob(output))
}

fn random_bytes(bytes: usize) -> Vec<u8> {
  let mut buffer = vec![0u8; bytes];
  let _ = unsafe { BCryptGenRandom(None, &mut buffer, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
  buffer
}

pub fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn from_hex(text: &str) -> Option<Vec<u8>> {
  (0..text.len()).step_by(2).map(|at| text.get(at..at + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok())).collect()
}

/// Випадкові байти з генератора Windows — шістнадцятковим рядком.
pub fn random_hex(bytes: usize) -> String {
  hex(&random_bytes(bytes))
}

/// PBKDF2-HMAC-SHA256 засобами Windows (CNG): системний код, швидкий і в налагоджувальній збірці.
fn pbkdf2_sha256(password: &[u8], salt: &[u8], rounds: u64) -> Option<SyncKey> {
  let mut algorithm = BCRYPT_ALG_HANDLE::default();
  unsafe { BCryptOpenAlgorithmProvider(&mut algorithm, BCRYPT_SHA256_ALGORITHM, PCWSTR::null(), BCRYPT_ALG_HANDLE_HMAC_FLAG) }
    .ok()
    .ok()?;
  let mut key = [0u8; 32];
  let password = (!password.is_empty()).then_some(password);
  let derived = unsafe { BCryptDeriveKeyPBKDF2(algorithm, password, Some(salt), rounds, &mut key, 0) }.ok();
  let _ = unsafe { BCryptCloseAlgorithmProvider(algorithm, 0) };
  derived.ok().map(|()| key)
}

/// Ключ синхронізації з пароля облікового запису. Сіль — id користувача: той самий пароль на іншому комп'ютері
/// дає той самий ключ, а в різних людей з однаковим паролем ключі різні.
pub fn derive_key(password: &str, user_id: &str) -> Option<SyncKey> {
  pbkdf2_sha256(password.as_bytes(), format!("astra-sync:{user_id}").as_bytes(), PBKDF2_ROUNDS)
}

/// Відбиток ключа: за ним видно, чи зашифровано дані тим самим ключем (після зміни пароля — вже іншим).
pub fn key_id(key: &SyncKey) -> String {
  hex(&Sha256::new().chain_update(b"astra-sync-key-id").chain_update(key).finalize()[..8])
}

/// HMAC-SHA256 від даних — шістнадцятковим рядком. Без ключа з нього не дізнатися, що зашифровано.
pub fn mac(key: &SyncKey, data: &[u8]) -> String {
  let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC приймає ключ будь-якої довжини");
  mac.update(data);
  hex(&mac.finalize().into_bytes())
}

/// AES-256-GCM з випадковим nonce: (nonce, шифр із тегом автентичності).
pub fn seal(key: &SyncKey, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
  let nonce = random_bytes(12);
  let sealed = Aes256Gcm::new(key.into()).encrypt(Nonce::from_slice(&nonce), plaintext).map_err(|error| error.to_string())?;
  Ok((nonce, sealed))
}

/// Розшифровує [`seal`]; чужий ключ чи змінені дані — помилка.
pub fn open(key: &SyncKey, nonce: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String> {
  if nonce.len() != 12 {
    return Err("Bad nonce".into());
  }
  Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(nonce), sealed).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_the_same_entropy_reads_it_back() {
    let sealed = protect("таємниця".as_bytes(), b"one").expect("protect");
    assert_eq!(unprotect(&sealed, b"one").expect("unprotect"), "таємниця".as_bytes());
    assert!(unprotect(&sealed, b"two").is_err());
    assert_eq!(random_hex(8).len(), 16);
  }

  #[test]
  fn windows_pbkdf2_matches_the_standard() {
    // Відомий вектор PBKDF2-HMAC-SHA256 і незалежна реалізація.
    let key = pbkdf2_sha256(b"password", b"salt", 1).expect("pbkdf2");
    assert_eq!(hex(&key), "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
    let mut expected = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>("пароль".as_bytes(), b"astra-sync:u", 1000, &mut expected);
    assert_eq!(pbkdf2_sha256("пароль".as_bytes(), b"astra-sync:u", 1000), Some(expected));
  }

  #[test]
  fn sync_encryption_needs_the_same_password_and_account() {
    let key = derive_key("пароль облікового запису", "user-1").expect("key");
    let other = derive_key("інший пароль", "user-1").expect("key");
    assert_eq!(Some(key), derive_key("пароль облікового запису", "user-1"));
    assert_ne!(Some(key), derive_key("пароль облікового запису", "user-2"));
    assert_ne!(key_id(&key), key_id(&other));

    let (nonce, sealed) = seal(&key, b"secret").expect("seal");
    assert_eq!(open(&key, &nonce, &sealed).expect("open"), b"secret");
    assert!(open(&other, &nonce, &sealed).is_err());
    assert_eq!(mac(&key, b"a"), mac(&key, b"a"));
    assert_eq!(from_hex(&hex(&[0, 255, 16])), Some(vec![0, 255, 16]));
  }
}
