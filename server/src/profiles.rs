//! Окремі дані кожного облікового запису на цьому комп'ютері: теки app_data/profiles/<id користувача>.
//!
//! Перший обліковий запис, що ввійшов на цьому комп'ютері, — «власник»: йому лишаються дані, що були тут до
//! облікових записів (паролі сайтів, cookies і входи на сайтах у типовій теці WebView2). Решта облікових записів
//! починають з чистого: свої паролі, свої cookies у власній теці WebView2.

use std::{fs, path::PathBuf, sync::Mutex};

use tauri::{AppHandle, Manager};

/// Хто з облікових записів — власник даних, що були до них.
const OWNER_FILE: &str = "owner";

/// Обліковий запис, що зараз увійшов (id користувача Supabase).
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

fn root(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_data_dir().ok().map(|dir| dir.join("profiles"))
}

/// id користувача — частина шляху, тож лише безпечні символи (у Supabase це UUID).
fn is_safe_id(id: &str) -> bool {
  !id.is_empty() && id.chars().all(|char| char.is_ascii_alphanumeric() || char == '-')
}

/// Тека даних облікового запису.
pub fn dir(app: &AppHandle, user: &str) -> Option<PathBuf> {
  is_safe_id(user).then(|| root(app)).flatten().map(|root| root.join(user))
}

/// Власник даних, що були до облікових записів. Першому, хто ввійшов, ця роль дістається назавжди.
pub fn is_owner(app: &AppHandle, user: &str) -> bool {
  let Some(root) = root(app) else {
    return false;
  };
  let file = root.join(OWNER_FILE);
  match fs::read_to_string(&file) {
    Ok(owner) => owner.trim() == user,
    Err(_) => is_safe_id(user) && fs::create_dir_all(&root).is_ok() && fs::write(&file, user).is_ok(),
  }
}

/// Обліковий запис змінився (`None` — вийшли).
pub fn set_current(user: Option<&str>) {
  if let Ok(mut current) = CURRENT.lock() {
    *current = user.map(str::to_string);
  }
}

pub fn current() -> Option<String> {
  CURRENT.lock().ok()?.clone()
}

/// Власна тека WebView2 облікового запису (у власника вона не використовується).
fn own_site_data_dir(app: &AppHandle, user: &str) -> Option<PathBuf> {
  let local = app.path().app_local_data_dir().ok()?;
  is_safe_id(user).then(|| local.join("profiles").join(user))
}

/// Тека WebView2 для сайтів поточного облікового запису: у власника — типова (його давні cookies й входи),
/// в інших — своя. `None` — типова.
pub fn site_data_dir(app: &AppHandle) -> Option<PathBuf> {
  let user = current()?;
  if is_owner(app, &user) {
    return None;
  }
  own_site_data_dir(app, &user)
}

/// Обліковий запис видалено: прибираємо його теку (паролі сайтів) і власну теку WebView2. Дані сайтів у ній
/// інтерфейс уже очистив, тож якщо теку ще тримають відкриті сторінки, лишаються хіба порожні файли. Власник
/// лишається власником: типову теку WebView2 (теж очищену) не отримає інший обліковий запис.
pub fn forget(app: &AppHandle, user: &str) {
  if let Some(dir) = dir(app, user) {
    let _ = fs::remove_dir_all(dir);
  }
  let owner = root(app).and_then(|root| fs::read_to_string(root.join(OWNER_FILE)).ok()).is_some_and(|owner| owner.trim() == user);
  if let Some(dir) = own_site_data_dir(app, user).filter(|_| !owner) {
    let _ = fs::remove_dir_all(dir);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn user_ids_cannot_escape_the_profiles_folder() {
    assert!(is_safe_id("1f0c2a7e-55b1-4c3e-9d1a-7d1f1f2b3c4d"));
    assert!(!is_safe_id("../owner"));
    assert!(!is_safe_id("a/b"));
    assert!(!is_safe_id(""));
  }
}
