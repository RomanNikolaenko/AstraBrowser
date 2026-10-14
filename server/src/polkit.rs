//! Підтвердження особи перед заповненням банківської картки (cards.rs) у Linux — як Windows Hello у Windows (hello.rs):
//! polkit просить пароль (чи відбиток) користувача у вікні агента автентифікації системи (GNOME, KDE). Дію ACTION
//! polkit знає з файла, який ставить пакет (linux/com.astrabrowser.desktop.policy); без нього (AppImage, розробка)
//! підтверджувати нічим — і картки заповнюються без підтвердження, як і там, де немає Windows Hello.

use std::{
  collections::HashMap,
  sync::atomic::{AtomicU8, Ordering},
};

use gtk::{
  gio,
  glib::{self, ToVariant},
};

/// Дія polkit: підтвердити, що за комп'ютером власник облікового запису (auth_self — щоразу).
const ACTION: &str = "com.astrabrowser.desktop.verify-identity";

const POLKIT: &str = "org.freedesktop.PolicyKit1";
const AUTHORITY_PATH: &str = "/org/freedesktop/PolicyKit1/Authority";
const AUTHORITY: &str = "org.freedesktop.PolicyKit1.Authority";

/// Чи знає polkit дію ACTION: 0 — ще не відомо, 1 — так, 2 — ні.
static AVAILABLE: AtomicU8 = AtomicU8::new(0);

/// Чи можна підтверджувати через polkit. Перший виклик питає polkit (чекає відповіді — не з головного потоку).
pub fn available() -> bool {
  match AVAILABLE.load(Ordering::Relaxed) {
    1 => true,
    2 => false,
    _ => {
      let available = registered().unwrap_or_else(|error| {
        log::info!("polkit недоступний: {error}");
        false
      });
      AVAILABLE.store(if available { 1 } else { 2 }, Ordering::Relaxed);
      available
    }
  }
}

/// Що вже відомо, не питаючи polkit: None — ще не перевіряли.
pub fn known() -> Option<bool> {
  match AVAILABLE.load(Ordering::Relaxed) {
    1 => Some(true),
    2 => Some(false),
    _ => None,
  }
}

fn system_bus() -> Result<gio::DBusConnection, glib::Error> {
  gio::bus_get_sync(gio::BusType::System, None::<&gio::Cancellable>)
}

/// Чи є дія ACTION серед тих, що знає polkit.
fn registered() -> Result<bool, glib::Error> {
  let reply = system_bus()?.call_sync(
    Some(POLKIT),
    AUTHORITY_PATH,
    AUTHORITY,
    "EnumerateActions",
    Some(&("",).to_variant()),
    glib::VariantTy::new("(a(ssssssuuua{ss}))").ok(),
    gio::DBusCallFlags::NONE,
    5000,
    None::<&gio::Cancellable>,
  )?;
  let actions = reply.child_value(0);
  Ok((0..actions.n_children()).any(|index| actions.child_value(index).child_value(0).str() == Some(ACTION)))
}

/// Просить підтвердити особу; чекає, доки користувач відповість, — лише не з головного потоку. true — підтвердив.
/// Вікно й пояснення показує агент polkit (текст — з файла дії), тож `window` і `message` — лише для однаковості з
/// Windows.
pub fn verify(_window: isize, _message: &str) -> Result<bool, String> {
  let bus = system_bus().map_err(|error| error.to_string())?;
  let name = bus.unique_name().ok_or("No system bus name")?;
  // Хто питає — сам браузер (його ім'я на системній шині), а не процес за номером, який могли б підмінити.
  let subject = ("system-bus-name", HashMap::from([("name".to_string(), name.as_str().to_variant())]));
  let details: HashMap<String, String> = HashMap::new();
  // 1 — AllowUserInteraction: polkit може показати вікно підтвердження.
  let arguments = (subject, ACTION, details, 1u32, "").to_variant();
  let reply = bus
    .call_sync(
      Some(POLKIT),
      AUTHORITY_PATH,
      AUTHORITY,
      "CheckAuthorization",
      Some(&arguments),
      glib::VariantTy::new("((bba{ss}))").ok(),
      gio::DBusCallFlags::NONE,
      // Скільки завгодно: користувач може довго вводити пароль.
      i32::MAX,
      None::<&gio::Cancellable>,
    )
    .map_err(|error| error.to_string())?;
  Ok(reply.child_value(0).child_value(0).get::<bool>().unwrap_or(false))
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Справжній polkit з файлом дії (linux/com.astrabrowser.desktop.policy у /usr/share/polkit-1/actions):
  /// `cargo test polkit -- --ignored`. Без агента автентифікації вікна не буде, а root polkit пропускає й так.
  #[test]
  #[ignore]
  fn asks_polkit() {
    assert!(available(), "polkit не знає {ACTION}");
    eprintln!("підтверджено: {:?}", verify(0, ""));
  }
}
