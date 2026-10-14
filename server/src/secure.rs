//! Шифрування того, що лежить на диску: розшифрувати може лише той самий користувач системи. У Windows — DPAPI
//! (CryptProtectData); у macOS і Linux — AES-256-GCM ключем застосунку, що лежить у сховищі секретів системи (Keychain
//! macOS, Secret Service у Linux), а без нього — у файлі, який може читати лише сам користувач. `entropy` — додатковий
//! «ключ» для кожного виду даних: паролі сайтів і сеанс облікового запису інша програма того самого користувача не
//! розшифрує, не знаючи його.
//!
//! Тут же — наскрізне шифрування для синхронізації: ключ виводиться з пароля облікового запису (PBKDF2), тож сервер
//! бачить лише зашифроване, а розшифрувати може тільки той, хто знає пароль.

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub use system::{protect, unprotect};
#[cfg(not(windows))]
pub use system::init;
use system::{pbkdf2_sha256, random_bytes};

/// Ключ синхронізації (AES-256).
pub type SyncKey = [u8; 32];

/// Раунди PBKDF2-HMAC-SHA256 — як радить OWASP: підбирати пароль до вкраденого шифру так довго, як тільки можна.
const PBKDF2_ROUNDS: u32 = 600_000;

#[cfg(windows)]
mod system {
  use windows::Win32::{
    Foundation::{LocalFree, HLOCAL},
    Security::Cryptography::{
      BCryptCloseAlgorithmProvider, BCryptDeriveKeyPBKDF2, BCryptGenRandom, BCryptOpenAlgorithmProvider, CryptProtectData,
      CryptUnprotectData, BCRYPT_ALG_HANDLE, BCRYPT_ALG_HANDLE_HMAC_FLAG, BCRYPT_SHA256_ALGORITHM,
      BCRYPT_USE_SYSTEM_PREFERRED_RNG, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
  };
  use windows_core::PCWSTR;

  use super::SyncKey;

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

  pub fn random_bytes(bytes: usize) -> Vec<u8> {
    let mut buffer = vec![0u8; bytes];
    let _ = unsafe { BCryptGenRandom(None, &mut buffer, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    buffer
  }

  /// PBKDF2-HMAC-SHA256 засобами Windows (CNG): системний код, швидкий і в налагоджувальній збірці.
  pub fn pbkdf2_sha256(password: &[u8], salt: &[u8], rounds: u32) -> Option<SyncKey> {
    let mut algorithm = BCRYPT_ALG_HANDLE::default();
    unsafe { BCryptOpenAlgorithmProvider(&mut algorithm, BCRYPT_SHA256_ALGORITHM, PCWSTR::null(), BCRYPT_ALG_HANDLE_HMAC_FLAG) }
      .ok()
      .ok()?;
    let mut key = [0u8; 32];
    let password = (!password.is_empty()).then_some(password);
    let derived = unsafe { BCryptDeriveKeyPBKDF2(algorithm, password, Some(salt), u64::from(rounds), &mut key, 0) }.ok();
    let _ = unsafe { BCryptCloseAlgorithmProvider(algorithm, 0) };
    derived.ok().map(|()| key)
  }
}

#[cfg(not(windows))]
mod system {
  use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    sync::{Mutex, OnceLock},
  };

  use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
  };
  use sha2::Sha256;

  use super::{from_hex, hex, SyncKey};

  /// Версія формату зашифрованого: перший байт.
  const VERSION: u8 = 1;
  /// Назва в сховищі секретів системи; обліковий запис у ньому — ідентифікатор застосунку (свій у розробки).
  #[cfg(not(test))]
  const SERVICE: &str = "Astra Browser";
  /// Файл з ключем, якщо сховища секретів немає (Linux без Secret Service).
  const KEY_FILE: &str = "master.key";

  /// Тека даних і ідентифікатор застосунку — звідки брати ключ (init).
  static PLACE: OnceLock<(PathBuf, String)> = OnceLock::new();
  /// Ключ застосунку: раз прочитаний чи створений, далі той самий до кінця роботи.
  static MASTER: Mutex<Option<SyncKey>> = Mutex::new(None);

  /// Де шукати ключ застосунку: тека даних (для файла) й ідентифікатор (обліковий запис у сховищі секретів). Викликає
  /// main.rs до першого шифрування.
  pub fn init(dir: PathBuf, identifier: String) {
    let _ = PLACE.set((dir, identifier));
  }

  fn master() -> Result<SyncKey, String> {
    let mut master = MASTER.lock().map_err(|error| error.to_string())?;
    if let Some(key) = *master {
      return Ok(key);
    }
    let key = load()?;
    *master = Some(key);
    Ok(key)
  }

  fn parse(text: &str) -> Option<SyncKey> {
    from_hex(text.trim())?.try_into().ok()
  }

  fn fresh() -> SyncKey {
    let mut key = [0u8; 32];
    key.copy_from_slice(&random_bytes(32));
    key
  }

  /// Ключ зі сховища секретів системи; у ньому немає й файла теж — новий ключ туди ж. Без сховища — файл: раз почавши
  /// з файла, застосунок і далі бере його, щоб не загубити зашифроване раніше.
  fn load() -> Result<SyncKey, String> {
    // Тести шифрують без main.rs: ключ — у тимчасовій теці свого процесу.
    #[cfg(test)]
    let _ = PLACE.set((std::env::temp_dir().join(format!("astra-secure-{}", std::process::id())), "test".into()));
    let (dir, identifier) = PLACE.get().ok_or("secure::init ще не викликано")?;
    let file = dir.join(KEY_FILE);
    let from_file = fs::read_to_string(&file).ok().and_then(|text| parse(&text));
    #[cfg(not(test))]
    if let Ok(entry) = keyring::Entry::new(SERVICE, identifier) {
      match entry.get_password() {
        Ok(text) => {
          if let Some(key) = parse(&text) {
            return Ok(key);
          }
        }
        Err(keyring::Error::NoEntry) if from_file.is_none() => {
          let key = fresh();
          if entry.set_password(&hex(&key)).is_ok() {
            return Ok(key);
          }
        }
        Err(error) => log::info!("secure: сховище секретів недоступне ({error}), ключ — у файлі"),
      }
    }
    #[cfg(test)]
    let _ = identifier;
    if let Some(key) = from_file {
      return Ok(key);
    }
    let key = fresh();
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let mut output = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&file).map_err(|error| error.to_string())?;
    output.write_all(hex(&key).as_bytes()).map_err(|error| error.to_string())?;
    Ok(key)
  }

  /// Версія, nonce і шифр AES-256-GCM, де `entropy` — додаткові автентифіковані дані: без неї не розшифрувати.
  pub fn protect(data: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    let key = master()?;
    let nonce = random_bytes(12);
    let sealed = Aes256Gcm::new((&key).into())
      .encrypt(Nonce::from_slice(&nonce), Payload { msg: data, aad: entropy })
      .map_err(|error| error.to_string())?;
    Ok([&[VERSION][..], &nonce, &sealed].concat())
  }

  pub fn unprotect(data: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    let (Some(&VERSION), Some(nonce), Some(sealed)) = (data.first(), data.get(1..13), data.get(13..)) else {
      return Err("Bad data".into());
    };
    let key = master()?;
    Aes256Gcm::new((&key).into())
      .decrypt(Nonce::from_slice(nonce), Payload { msg: sealed, aad: entropy })
      .map_err(|error| error.to_string())
  }

  pub fn random_bytes(bytes: usize) -> Vec<u8> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("генератор випадкових чисел системи");
    buffer
  }

  pub fn pbkdf2_sha256(password: &[u8], salt: &[u8], rounds: u32) -> Option<SyncKey> {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password, salt, rounds, &mut key);
    Some(key)
  }
}

pub fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn from_hex(text: &str) -> Option<Vec<u8>> {
  (0..text.len()).step_by(2).map(|at| text.get(at..at + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok())).collect()
}

/// Випадкові байти з генератора системи — шістнадцятковим рядком.
pub fn random_hex(bytes: usize) -> String {
  hex(&random_bytes(bytes))
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
    assert!(!sealed.windows(4).any(|part| part == "таєм".as_bytes()));
    assert_eq!(unprotect(&sealed, b"one").expect("unprotect"), "таємниця".as_bytes());
    assert!(unprotect(&sealed, b"two").is_err());
    assert_eq!(random_hex(8).len(), 16);
  }

  #[test]
  fn pbkdf2_matches_the_standard() {
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
