//! Події сторінки сайту, на які браузер відповідає сам, і керування нею, якого не дає Tauri:
//! - збій процесу сторінки — інтерфейс показує «Сторінка аварійно завершила роботу» з кнопкою «Перезавантажити»;
//! - запити дозволів (камера, мікрофон, геолокація, сповіщення…) — питає інтерфейс, а не стандартний діалог WebView2;
//! - нові вікна від сайту — новими вкладками; без дії користувача (спливні вікна) інтерфейс їх блокує;
//! - контекстне меню — з діями браузера: відкрити посилання в новій вкладці, шукати й перекласти виділене тощо;
//! - сплячі вкладки (WebView2 присипляє приховану сторінку) й SmartScreen (захист від фішингу й шкідливих файлів);
//! - власне автозаповнення WebView2 вимкнено: форми заповнює браузер (addresses.rs).

use std::{
  cell::RefCell,
  collections::HashMap,
  sync::atomic::{AtomicU64, Ordering},
};

use tauri::{Url, Webview};
use webview2_com::{
  take_pwstr, ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler, GetNonDefaultPermissionSettingsCompletedHandler,
  Microsoft::Web::WebView2::Win32::*, NewWindowRequestedEventHandler, PermissionRequestedEventHandler, ProcessFailedEventHandler,
  SetPermissionStateCompletedHandler, TrySuspendCompletedHandler,
};
use windows_core::{Interface, BOOL, HSTRING, PWSTR};

use crate::{
  context_menu::{custom_items, ContextAction, MenuTarget},
  page_types::{Failure, PermissionRequest, PermissionState},
  webview2::{core, profile, Reply},
};

/// Збій процесу сторінки — `report(Failure)`. Збої процесів iframe не рахуються: сама сторінка працює далі.
pub fn watch_process_failed(webview: &Webview, report: impl Fn(Failure) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
          return Ok(());
        };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        unsafe { args.ProcessFailedKind(&mut kind)? };
        let failure = match kind {
          COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => Failure::Exited,
          COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => Failure::Unresponsive,
          COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => Failure::Browser,
          _ => return Ok(()),
        };
        report(failure);
        Ok(())
      }));
      let mut token = 0;
      unsafe { core(&platform)?.add_ProcessFailed(&handler, &mut token) }
    };
    if let Err(error) = watch() {
      log::warn!("page: не вдалося стежити за процесом сторінки: {error}");
    }
  })
}

/// Microsoft Defender SmartScreen для сторінки: попереджає про фішинг і шкідливі завантаження.
pub fn set_smart_screen(webview: &Webview, enabled: bool) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let set = || -> windows_core::Result<()> {
      let settings: ICoreWebView2Settings9 = unsafe { core(&platform)?.Settings()?.cast()? };
      unsafe { settings.SetIsReputationCheckingRequired(enabled) }
    };
    if let Err(error) = set() {
      log::warn!("page: не вдалося задати SmartScreen: {error}");
    }
  })
}

/// Власне автозаповнення WebView2 (збережені введення й адреси Chromium) — вимкнене: його даних не видно, вони не
/// синхронізуються, а його підказки лягали б поверх списку адрес браузера (addresses.rs).
pub fn disable_general_autofill(webview: &Webview) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let set = || -> windows_core::Result<()> {
      let settings: ICoreWebView2Settings4 = unsafe { core(&platform)?.Settings()?.cast()? };
      unsafe { settings.SetIsGeneralAutofillEnabled(false) }
    };
    if let Err(error) = set() {
      log::warn!("page: не вдалося вимкнути автозаповнення WebView2: {error}");
    }
  })
}

/// Фонова вкладка — менше пам'яті (WebView2 звільняє кеші); активна — як зазвичай.
pub fn set_background(webview: &Webview, background: bool) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let level = if background { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
    let _ = core(&platform).and_then(|core| unsafe { core.cast::<ICoreWebView2_19>()?.SetMemoryUsageTargetLevel(level) });
  })
}

/// Присипляє приховану сторінку: скрипти й таймери зупиняються, пам'ять звільняється, а стан сторінки лишається.
/// Прокидається вона сама, щойно її знову покажуть. `reply(true)` — заснула (сторінку, що грає звук чи ще
/// видима, WebView2 не присипляє).
pub fn suspend(webview: &Webview, reply: Reply<bool>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let request = || -> windows_core::Result<()> {
      let handler = TrySuspendCompletedHandler::create(Box::new(move |result, suspended| {
        let _ = reply.send(result.map(|()| suspended).map_err(|error| error.to_string()));
        Ok(())
      }));
      unsafe { core(&platform)?.cast::<ICoreWebView2_3>()?.TrySuspend(&handler) }
    };
    if let Err(error) = request() {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

// --- Дозволи ---

impl PermissionState {
  fn state(self) -> COREWEBVIEW2_PERMISSION_STATE {
    match self {
      PermissionState::Allow => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
      PermissionState::Deny => COREWEBVIEW2_PERMISSION_STATE_DENY,
      PermissionState::Ask => COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
    }
  }

  fn from_state(state: COREWEBVIEW2_PERMISSION_STATE) -> Self {
    match state {
      COREWEBVIEW2_PERMISSION_STATE_ALLOW => PermissionState::Allow,
      COREWEBVIEW2_PERMISSION_STATE_DENY => PermissionState::Deny,
      _ => PermissionState::Ask,
    }
  }
}

/// Дозволи, про які питає браузер (автовідтворення вирішують свої правила, audio.rs).
const PERMISSIONS: &[(COREWEBVIEW2_PERMISSION_KIND, &str)] = &[
  (COREWEBVIEW2_PERMISSION_KIND_CAMERA, "camera"),
  (COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, "microphone"),
  (COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION, "location"),
  (COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, "notifications"),
  (COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ, "clipboard"),
  (COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS, "sensors"),
  (COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS, "downloads"),
  (COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE, "files"),
  (COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS, "fonts"),
  (COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES, "midi"),
  (COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT, "windows"),
];

fn kind_name(kind: COREWEBVIEW2_PERMISSION_KIND) -> Option<&'static str> {
  PERMISSIONS.iter().find(|(known, _)| *known == kind).map(|(_, name)| *name)
}

fn kind_of(name: &str) -> Option<COREWEBVIEW2_PERMISSION_KIND> {
  PERMISSIONS.iter().find(|(_, known)| *known == name).map(|(kind, _)| *kind)
}

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

thread_local! {
  /// Запити, що чекають відповіді (лише в головному потоці: об'єкти WebView2 не можна передавати між потоками).
  static PENDING: RefCell<HashMap<u64, (ICoreWebView2PermissionRequestedEventArgs, ICoreWebView2Deferral)>> = RefCell::new(HashMap::new());
}

/// Запити дозволів сторінки — інтерфейсу (`report`), відповідь — [`answer_permission`].
pub fn watch_permissions(webview: &Webview, report: impl Fn(PermissionRequest) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
          return Ok(());
        };
        let (mut kind, mut uri, mut user) = (COREWEBVIEW2_PERMISSION_KIND::default(), PWSTR::null(), BOOL::default());
        unsafe {
          args.PermissionKind(&mut kind)?;
          args.Uri(&mut uri)?;
          args.IsUserInitiated(&mut user)?;
        }
        let Some(name) = kind_name(kind) else {
          return Ok(());
        };
        let origin = Url::parse(&take_pwstr(uri)).map(|url| url.origin().ascii_serialization()).unwrap_or_default();
        let deferral = unsafe { args.GetDeferral()? };
        let id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
        PENDING.with(|pending| pending.borrow_mut().insert(id, (args, deferral)));
        report(PermissionRequest { id, kind: name, origin, user_initiated: user.as_bool() });
        Ok(())
      }));
      let mut token = 0;
      unsafe { core(&platform)?.add_PermissionRequested(&handler, &mut token) }
    };
    if let Err(error) = watch() {
      log::warn!("page: не вдалося стежити за дозволами сторінки: {error}");
    }
  })
}

/// Відповідь на запит дозволу; `remember` — запам'ятати для сайту (у профілі WebView2). Викликати в головному потоці.
pub fn answer_permission(id: u64, state: PermissionState, remember: bool) {
  let Some((args, deferral)) = PENDING.with(|pending| pending.borrow_mut().remove(&id)) else {
    return;
  };
  // «Питати» як відповідь — це «не цього разу»: інакше WebView2 показав би власний діалог.
  let state = if state == PermissionState::Ask { PermissionState::Deny } else { state };
  unsafe {
    if let Ok(args) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
      let _ = args.SetSavesInProfile(remember);
    }
    let _ = args.SetState(state.state());
    let _ = deferral.Complete();
  }
}

/// Збережені дозволи сайту `origin`: назва дозволу → стан (без збереженого — «питати»).
pub fn site_permissions(webview: &Webview, origin: String, reply: Reply<HashMap<String, PermissionState>>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let request = || -> windows_core::Result<()> {
      let handler = GetNonDefaultPermissionSettingsCompletedHandler::create(Box::new(move |result, settings| {
        let read = || -> windows_core::Result<HashMap<String, PermissionState>> {
          result?;
          let mut found = HashMap::new();
          let Some(settings) = settings else {
            return Ok(found);
          };
          let mut count = 0;
          unsafe { settings.Count(&mut count)? };
          for index in 0..count {
            let setting = unsafe { settings.GetValueAtIndex(index)? };
            let (mut kind, mut state, mut setting_origin) =
              (COREWEBVIEW2_PERMISSION_KIND::default(), COREWEBVIEW2_PERMISSION_STATE::default(), PWSTR::null());
            unsafe {
              setting.PermissionKind(&mut kind)?;
              setting.PermissionState(&mut state)?;
              setting.PermissionOrigin(&mut setting_origin)?;
            }
            if let Some(name) = kind_name(kind).filter(|_| take_pwstr(setting_origin).trim_end_matches('/') == origin) {
              found.insert(name.to_string(), PermissionState::from_state(state));
            }
          }
          Ok(found)
        };
        let _ = reply.send(read().map_err(|error| error.to_string()));
        Ok(())
      }));
      unsafe { profile(&platform)?.GetNonDefaultPermissionSettings(&handler) }
    };
    if let Err(error) = request() {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

/// Зберігає дозвіл `kind` для сайту `origin` у профілі WebView2.
pub fn set_site_permission(webview: &Webview, origin: String, kind: String, state: PermissionState, reply: Reply<()>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let request = || -> windows_core::Result<()> {
      let kind = kind_of(&kind).ok_or_else(|| windows_core::Error::from(windows::Win32::Foundation::E_INVALIDARG))?;
      let handler = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
        let _ = reply.send(result.map_err(|error| error.to_string()));
        Ok(())
      }));
      unsafe { profile(&platform)?.SetPermissionState(kind, &HSTRING::from(origin.as_str()), state.state(), &handler) }
    };
    if let Err(error) = request() {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

// --- Нові вікна ---

/// Сайт відкриває нове вікно (посилання з target="_blank", window.open): власного вікна WebView2 не буде —
/// `report(адреса, після дії користувача, None)`, а інтерфейс відкриє вкладку чи заблокує спливне вікно. Чим відкрито
/// (коліщатком, з Ctrl), WebView2 не каже — такі посилання відкриває скрипт сторінки (new-tab-page.js), а тут — завжди
/// одразу на нову вкладку.
pub fn watch_new_windows(webview: &Webview, report: impl Fn(String, bool, Option<bool>) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let handler = NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
          return Ok(());
        };
        let (mut uri, mut user) = (PWSTR::null(), BOOL::default());
        unsafe {
          args.Uri(&mut uri)?;
          args.IsUserInitiated(&mut user)?;
          args.SetHandled(true)?;
        }
        report(take_pwstr(uri), user.as_bool(), None);
        Ok(())
      }));
      let mut token = 0;
      unsafe { core(&platform)?.add_NewWindowRequested(&handler, &mut token) }
    };
    if let Err(error) = watch() {
      log::warn!("page: не вдалося стежити за новими вікнами: {error}");
    }
  })
}

// --- Контекстне меню ---

/// Пункти WebView2, яких у браузері не треба: свої «відкрити в новому вікні» (у нас — нові вкладки й вікна),
/// поділитися, знімок Edge й QR-код Edge, яких тут немає.
const REMOVED_ITEMS: &[&str] = &["openLinkInNewWindow", "share", "webCapture", "createQrCode", "openImageInNewWindow"];

/// Контекстне меню сайту — стандартне меню WebView2 зі своїми пунктами браузера; вибраний пункт — `report`.
pub fn customize_context_menu(webview: &Webview, report: impl Fn(ContextAction) + Clone + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let environment = platform.environment();
    let watch = || -> windows_core::Result<()> {
      let environment: ICoreWebView2Environment9 = environment.cast()?;
      let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
          return Ok(());
        };
        let target = read_target(&unsafe { args.ContextMenuTarget()? })?;
        let items = unsafe { args.MenuItems()? };
        remove_items(&items)?;
        let (top, bottom) = custom_items(&target);
        let source = bottom.iter().any(|(action, _, _)| *action == "view-source");
        for (index, (action, label, value)) in (0u32..).zip(top) {
          unsafe { items.InsertValueAtIndex(index, &menu_item(&environment, action, &label, value, report.clone())?)? };
        }
        let mut count = 0;
        unsafe { items.Count(&mut count)? };
        for (action, label, value) in bottom {
          unsafe { items.InsertValueAtIndex(count, &menu_item(&environment, action, &label, value, report.clone())?)? };
          count += 1;
        }
        if source {
          move_to_end(&items, INSPECT_ITEM)?;
        }
        Ok(())
      }));
      let mut token = 0;
      unsafe { core(&platform)?.cast::<ICoreWebView2_11>()?.add_ContextMenuRequested(&handler, &mut token) }
    };
    if let Err(error) = watch() {
      log::warn!("page: не вдалося змінити контекстне меню: {error}");
    }
  })
}

fn read_target(target: &ICoreWebView2ContextMenuTarget) -> windows_core::Result<MenuTarget> {
  let (mut has_link, mut has_source, mut has_selection, mut editable) = (BOOL::default(), BOOL::default(), BOOL::default(), BOOL::default());
  let mut kind = COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND::default();
  unsafe {
    target.HasLinkUri(&mut has_link)?;
    target.HasSourceUri(&mut has_source)?;
    target.HasSelection(&mut has_selection)?;
    target.IsEditable(&mut editable)?;
    target.Kind(&mut kind)?;
  }
  let text = |read: unsafe fn(&ICoreWebView2ContextMenuTarget, *mut PWSTR) -> windows_core::Result<()>| -> windows_core::Result<String> {
    let mut value = PWSTR::null();
    unsafe { read(target, &mut value)? };
    Ok(take_pwstr(value))
  };
  let web = |url: String| Some(url).filter(|url| url.starts_with("http://") || url.starts_with("https://"));
  Ok(MenuTarget {
    page: web(text(ICoreWebView2ContextMenuTarget::PageUri)?),
    link: if has_link.as_bool() { web(text(ICoreWebView2ContextMenuTarget::LinkUri)?) } else { None },
    image: if has_source.as_bool() && kind == COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE {
      web(text(ICoreWebView2ContextMenuTarget::SourceUri)?)
    } else {
      None
    },
    selection: if has_selection.as_bool() {
      Some(text(ICoreWebView2ContextMenuTarget::SelectionText)?).filter(|text| !text.trim().is_empty())
    } else {
      None
    },
    editable: editable.as_bool(),
  })
}

/// Пункт WebView2 «Перевірити» (інструменти розробника на елементі).
const INSPECT_ITEM: &str = "inspectElement";

/// Пункт WebView2 з назвою `name` — у кінець меню (якщо він є).
fn move_to_end(items: &ICoreWebView2ContextMenuItemCollection, name: &str) -> windows_core::Result<()> {
  let mut count = 0;
  unsafe { items.Count(&mut count)? };
  for index in 0..count {
    let item = unsafe { items.GetValueAtIndex(index)? };
    let mut found = PWSTR::null();
    unsafe { item.Name(&mut found)? };
    if take_pwstr(found) == name {
      unsafe {
        items.RemoveValueAtIndex(index)?;
        items.InsertValueAtIndex(count - 1, &item)?;
      }
      break;
    }
  }
  Ok(())
}

fn remove_items(items: &ICoreWebView2ContextMenuItemCollection) -> windows_core::Result<()> {
  let mut count = 0;
  unsafe { items.Count(&mut count)? };
  for index in (0..count).rev() {
    let item = unsafe { items.GetValueAtIndex(index)? };
    let mut name = PWSTR::null();
    unsafe { item.Name(&mut name)? };
    if REMOVED_ITEMS.contains(&take_pwstr(name).as_str()) {
      unsafe { items.RemoveValueAtIndex(index)? };
    }
  }
  Ok(())
}

fn menu_item(
  environment: &ICoreWebView2Environment9,
  action: &'static str,
  label: &str,
  value: Option<String>,
  report: impl Fn(ContextAction) + 'static,
) -> windows_core::Result<ICoreWebView2ContextMenuItem> {
  if action.is_empty() {
    return unsafe { environment.CreateContextMenuItem(&HSTRING::new(), None, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR) };
  }
  let item = unsafe { environment.CreateContextMenuItem(&HSTRING::from(label), None, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND)? };
  let is_text = matches!(action, "search" | "translate-text");
  let handler = CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
    let (url, text) = if is_text { (None, value.clone()) } else { (value.clone(), None) };
    report(ContextAction { action, url, text });
    Ok(())
  }));
  let mut token = 0;
  unsafe { item.add_CustomItemSelected(&handler, &mut token)? };
  Ok(item)
}
