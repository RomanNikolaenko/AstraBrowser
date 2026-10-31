//! Windows Hello: підтвердити, що за комп'ютером власник (PIN, відбиток, обличчя), перш ніж віддати сайтові дані
//! банківської картки (cards.rs). Вікно підтвердження — системне, над вікном браузера.

use std::sync::atomic::{AtomicU8, Ordering};

use windows::{
  core::{factory, HSTRING},
  Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability},
  Win32::{Foundation::HWND, System::WinRT::IUserConsentVerifierInterop},
};
use windows_future::IAsyncOperation;

/// Чи налаштовано Windows Hello: 0 — ще не відомо, 1 — так, 2 — ні.
static AVAILABLE: AtomicU8 = AtomicU8::new(0);

/// Чи можна підтверджувати через Windows Hello. Перший виклик питає Windows (чекає відповіді — не з головного потоку).
pub fn available() -> bool {
  match AVAILABLE.load(Ordering::Relaxed) {
    1 => true,
    2 => false,
    _ => {
      let available = UserConsentVerifier::CheckAvailabilityAsync()
        .and_then(|operation| operation.join())
        .is_ok_and(|availability| availability == UserConsentVerifierAvailability::Available);
      AVAILABLE.store(if available { 1 } else { 2 }, Ordering::Relaxed);
      available
    }
  }
}

/// Що вже відомо, не питаючи Windows: None — ще не перевіряли.
pub fn known() -> Option<bool> {
  match AVAILABLE.load(Ordering::Relaxed) {
    1 => Some(true),
    2 => Some(false),
    _ => None,
  }
}

/// Просить підтвердити особу над вікном `window` (HWND числом) з поясненням `message`. Чекає, доки користувач
/// відповість, — лише не з головного потоку. true — підтвердив.
pub fn verify(window: isize, message: &str) -> Result<bool, String> {
  let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(|error| error.to_string())?;
  let operation: IAsyncOperation<UserConsentVerificationResult> =
    unsafe { interop.RequestVerificationForWindowAsync(HWND(window as _), &HSTRING::from(message)) }
      .map_err(|error| error.to_string())?;
  Ok(operation.join().map_err(|error| error.to_string())? == UserConsentVerificationResult::Verified)
}
