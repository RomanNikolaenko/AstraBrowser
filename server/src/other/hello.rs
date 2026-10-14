//! Підтвердження особи перед заповненням банківської картки (cards.rs): у Windows — Windows Hello (src/hello.rs),
//! на macOS і Linux його ще немає, тож картки заповнюються без підтвердження.

/// Чи можна підтверджувати особу системою.
pub fn available() -> bool {
  false
}

/// Що вже відомо, не питаючи систему.
pub fn known() -> Option<bool> {
  Some(false)
}

/// Підтвердження особи над вікном `window`; без системного способу — помилка.
pub fn verify(_window: isize, _message: &str) -> Result<bool, String> {
  Err("Identity verification isn't available on this system".into())
}
