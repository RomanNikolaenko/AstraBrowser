//! Те, чого Tauri не відкриває, — напряму через WebView2: іконка й звук сторінки, навігація історією
//! й дозвіл сайту на автовідтворення.
//!
//! Тут свідомо немає ExecuteScript (eval): скрипт, запущений через WebView2, дає сторінці «активацію
//! користувача», і вона могла б без жодного кліку запускати відео зі звуком чи відкривати вікна.
//!
//! Усе виконується на головному потоці (`with_webview`), а відповіді COM приходять у колбеки,
//! тож результат повертається через канал, який чекає команда.

use std::sync::mpsc::Sender;

use tauri::{webview::PlatformWebview, Webview};
use webview2_com::{
  take_pwstr, AddScriptToExecuteOnDocumentCreatedCompletedHandler, CallDevToolsProtocolMethodCompletedHandler,
  CapturePreviewCompletedHandler, ContainsFullScreenElementChangedEventHandler, FaviconChangedEventHandler,
  GetCookiesCompletedHandler, GetNonDefaultPermissionSettingsCompletedHandler, HistoryChangedEventHandler,
  IsDocumentPlayingAudioChangedEventHandler, IsMutedChangedEventHandler, Microsoft::Web::WebView2::Win32::*,
  SetPermissionStateCompletedHandler, SourceChangedEventHandler,
};
use windows::Win32::{
  Foundation::E_OUTOFMEMORY,
  System::Com::{IStream, STREAM_SEEK_SET},
  UI::Shell::SHCreateMemStream,
};
use windows_core::{IUnknown, Interface, BOOL, HSTRING, PWSTR};

/// Відповідь, яку команда чекає з головного потоку.
pub type Reply<T> = Sender<Result<T, String>>;

/// Дозвіл на автовідтворення: явно дозволено, заборонено чи як за замовчуванням.
#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Autoplay {
  Allow,
  Block,
  Default,
}

impl Autoplay {
  fn state(self) -> COREWEBVIEW2_PERMISSION_STATE {
    match self {
      Self::Allow => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
      Self::Block => COREWEBVIEW2_PERMISSION_STATE_DENY,
      Self::Default => COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
    }
  }

  fn from_state(state: COREWEBVIEW2_PERMISSION_STATE) -> Self {
    match state {
      COREWEBVIEW2_PERMISSION_STATE_ALLOW => Self::Allow,
      COREWEBVIEW2_PERMISSION_STATE_DENY => Self::Block,
      _ => Self::Default,
    }
  }
}

fn core(platform: &PlatformWebview) -> windows_core::Result<ICoreWebView2> {
  unsafe { platform.controller().CoreWebView2() }
}

/// Профіль webview: у приватному вікні — окремий InPrivate, тож і дозволи там не зберігаються.
fn profile(platform: &PlatformWebview) -> windows_core::Result<ICoreWebView2Profile4> {
  unsafe { core(platform)?.cast::<ICoreWebView2_13>()?.Profile()?.cast() }
}

/// Повідомляє `report(page_url, icon_url)`, коли WebView2 визначив іконку сторінки (порожня — іконки немає).
pub fn watch_favicon(webview: &Webview, report: impl Fn(String, String) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let core = core(&platform)?.cast::<ICoreWebView2_15>()?;
      let handler = FaviconChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(sender) = sender {
          let (mut page, mut icon) = (PWSTR::null(), PWSTR::null());
          unsafe {
            sender.Source(&mut page)?;
            sender.cast::<ICoreWebView2_15>()?.FaviconUri(&mut icon)?;
          }
          report(take_pwstr(page), take_pwstr(icon));
        }
        Ok(())
      }));
      let mut token = 0;
      unsafe { core.add_FaviconChanged(&handler, &mut token) }
    };
    let _ = watch();
  })
}

/// Повідомляє `report(fullscreen)`, коли сторінка входить у повноекранний режим (відео тощо) чи виходить з нього.
/// Сам webview про розміри не дбає: розтягнути його на все вікно — справа інтерфейсу.
pub fn watch_fullscreen(webview: &Webview, report: impl Fn(bool) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(sender) = sender {
          let mut fullscreen = BOOL::default();
          unsafe { sender.ContainsFullScreenElement(&mut fullscreen)? };
          report(fullscreen.as_bool());
        }
        Ok(())
      }));
      let mut token = 0;
      unsafe { core(&platform)?.add_ContainsFullScreenElementChanged(&handler, &mut token) }
    };
    let _ = watch();
  })
}

/// Замінює скрипт, що виконується на початку кожного документа: прибирає попередній (за id) і додає новий.
/// `added(id)` отримує id нового — щоб наступного разу прибрати вже його.
pub fn replace_document_script(
  webview: &Webview,
  previous: Option<String>,
  script: String,
  added: impl FnOnce(String) + Send + 'static,
) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let replace = || -> windows_core::Result<()> {
      let core = core(&platform)?;
      if let Some(previous) = previous {
        unsafe { core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(previous.as_str()))? };
      }
      let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
        if result.is_ok() {
          added(id);
        }
        Ok(())
      }));
      unsafe { core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script.as_str()), &handler) }
    };
    let _ = replace();
  })
}

/// Знімок того, що зараз показує сторінка (JPEG). Поки відкрита панель інтерфейсу, сам webview
/// доводиться ховати (він малюється поверх HTML), і на його місці показується цей знімок.
pub fn capture(webview: &Webview, reply: Reply<Vec<u8>>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let request = || -> windows_core::Result<()> {
      let stream = unsafe { SHCreateMemStream(None) }.ok_or_else(|| windows_core::Error::from(E_OUTOFMEMORY))?;
      let image = stream.clone();
      let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        let bytes = result.and_then(|()| read_stream(&image));
        let _ = reply.send(bytes.map_err(|error| error.to_string()));
        Ok(())
      }));
      unsafe { core(&platform)?.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, &stream, &handler) }
    };
    if let Err(error) = request() {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

fn read_stream(stream: &IStream) -> windows_core::Result<Vec<u8>> {
  unsafe { stream.Seek(0, STREAM_SEEK_SET, None)? };
  let (mut bytes, mut chunk) = (Vec::new(), vec![0u8; 256 * 1024]);
  loop {
    let mut read = 0u32;
    unsafe { stream.Read(chunk.as_mut_ptr().cast(), chunk.len() as u32, Some(&mut read)).ok()? };
    if read == 0 {
      return Ok(bytes);
    }
    bytes.extend_from_slice(&chunk[..read as usize]);
  }
}

/// Повідомляє `report(url, can_go_back, can_go_forward)` на кожну зміну адреси чи історії вкладки —
/// зокрема коли сайт змінює адресу без перезавантаження (history.pushState, як YouTube).
pub fn watch_navigation(webview: &Webview, report: impl Fn(String, bool, bool) + Clone + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let core = core(&platform)?;
      let on_source = report.clone();
      let mut token = 0;
      unsafe {
        core.add_SourceChanged(
          &SourceChangedEventHandler::create(Box::new(move |sender, _| report_navigation(sender, &on_source))),
          &mut token,
        )?;
        core.add_HistoryChanged(
          &HistoryChangedEventHandler::create(Box::new(move |sender, _| report_navigation(sender, &report))),
          &mut token,
        )?;
      }
      Ok(())
    };
    let _ = watch();
  })
}

fn report_navigation(sender: Option<ICoreWebView2>, report: &impl Fn(String, bool, bool)) -> windows_core::Result<()> {
  if let Some(core) = sender {
    let (mut url, mut back, mut forward) = (PWSTR::null(), BOOL::default(), BOOL::default());
    unsafe {
      core.Source(&mut url)?;
      core.CanGoBack(&mut back)?;
      core.CanGoForward(&mut forward)?;
    }
    report(take_pwstr(url), back.as_bool(), forward.as_bool());
  }
  Ok(())
}

/// Особливі оновлення з меню кнопки «Оновити».
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReloadMode {
  /// Повторно завантажити все, минаючи кеш.
  Hard,
  /// Сховища кешу сайту (Cache Storage) — і жорстке оновлення.
  Cache,
  /// Кеш, localStorage, sessionStorage, IndexedDB тощо — без cookies.
  SiteData,
  /// Cookies сайту (вийде з облікового запису) — і звичайне оновлення.
  Cookies,
}

/// Виконує `mode` для поточного сайту вкладки (`url`, `origin`) і перезавантажує сторінку.
/// Усе — через сам WebView2 і протокол DevTools, без скриптів, які бачила б сторінка.
pub fn reload_with(webview: &Webview, mode: ReloadMode, url: String, origin: String, reply: Reply<()>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let core = match core(&platform) {
      Ok(core) => core,
      Err(error) => return finish(&reply, Err(error)),
    };
    match mode {
      ReloadMode::Hard => hard_reload(&core, reply),
      ReloadMode::Cache => clear_origin_and_reload(core, &origin, "cache_storage", reply),
      ReloadMode::SiteData => {
        // sessionStorage належить вкладці, а не сайту, тож його чистимо в самій сторінці — без жесту користувача.
        let (page, failed) = (core.clone(), reply.clone());
        let started = devtools(&core, "Runtime.evaluate", r#"{"expression":"sessionStorage.clear()"}"#, move |_| {
          clear_origin_and_reload(page, &origin, "cache_storage,local_storage,indexeddb,service_workers,file_systems,websql", reply);
        });
        if let Err(error) = started {
          finish(&failed, Err(error));
        }
      }
      ReloadMode::Cookies => delete_cookies_and_reload(core, &url, reply),
    }
  })
}

fn finish(reply: &Reply<()>, result: windows_core::Result<()>) {
  let _ = reply.send(result.map_err(|error| error.to_string()));
}

/// Метод протоколу DevTools у самому WebView2; `then` отримує відповідь як JSON.
fn devtools(core: &ICoreWebView2, method: &str, params: &str, then: impl FnOnce(windows_core::Result<String>) + 'static) -> windows_core::Result<()> {
  let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
    then(result.map(|()| json));
    Ok(())
  }));
  unsafe { core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params), &handler) }
}

fn hard_reload(core: &ICoreWebView2, reply: Reply<()>) {
  let failed = reply.clone();
  let started = devtools(core, "Page.reload", r#"{"ignoreCache":true}"#, move |result| finish(&reply, result.map(|_| ())));
  if let Err(error) = started {
    finish(&failed, Err(error));
  }
}

/// Дані сайту в сховищах заданих типів (назви — як у Storage.clearDataForOrigin), а тоді жорстке оновлення.
fn clear_origin_and_reload(core: ICoreWebView2, origin: &str, types: &str, reply: Reply<()>) {
  let (page, failed) = (core.clone(), reply.clone());
  let params = serde_json::json!({ "origin": origin, "storageTypes": types }).to_string();
  let started = devtools(&core, "Storage.clearDataForOrigin", &params, move |result| match result {
    Ok(_) => hard_reload(&page, reply),
    Err(error) => finish(&reply, Err(error)),
  });
  if let Err(error) = started {
    finish(&failed, Err(error));
  }
}

/// Усі cookies, що надсилаються на `url` (і самого хоста, і домену), а тоді звичайне оновлення.
fn delete_cookies_and_reload(core: ICoreWebView2, url: &str, reply: Reply<()>) {
  let failed = reply.clone();
  let start = || -> windows_core::Result<()> {
    let manager = unsafe { core.cast::<ICoreWebView2_2>()?.CookieManager()? };
    let deleting = manager.clone();
    let handler = GetCookiesCompletedHandler::create(Box::new(move |result, cookies| {
      let delete = || -> windows_core::Result<()> {
        result?;
        if let Some(cookies) = cookies {
          let mut count = 0;
          unsafe { cookies.Count(&mut count)? };
          for index in 0..count {
            unsafe { deleting.DeleteCookie(&cookies.GetValueAtIndex(index)?)? };
          }
        }
        unsafe { core.Reload() }
      };
      finish(&reply, delete());
      Ok(())
    }));
    unsafe { manager.GetCookies(&HSTRING::from(url), &handler) }
  };
  if let Err(error) = start() {
    finish(&failed, Err(error));
  }
}

/// Вмикає «картинку в картинці» для відео, що грає (з кількох — найбільшого), або вимикає, якщо вже ввімкнена.
const PICTURE_IN_PICTURE_SCRIPT: &str = r#"(async () => {
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return 'closed';
  }
  const area = (video) => video.clientWidth * video.clientHeight;
  const videos = [...document.querySelectorAll('video')]
    .filter((video) => video.readyState > 0 && !video.disablePictureInPicture)
    .sort((a, b) => area(b) - area(a));
  const video = videos.find((video) => !video.paused) ?? videos[0];
  if (!video) {
    return 'no-video';
  }
  await video.requestPictureInPicture();
  return 'opened';
})()"#;

/// Перемикає «картинку в картинці». Без жесту користувача браузер її не дозволить, тож скрипт
/// виконується з жестом — це чесно, бо запускає його сам користувач (кнопка чи Ctrl+Shift+]).
/// `reply` отримує opened, closed чи no-video.
pub fn picture_in_picture(webview: &Webview, reply: Reply<String>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let params = serde_json::json!({
      "expression": PICTURE_IN_PICTURE_SCRIPT,
      "userGesture": true,
      "awaitPromise": true,
      "returnByValue": true,
    })
    .to_string();
    let started = core(&platform).and_then(|core| {
      devtools(&core, "Runtime.evaluate", &params, move |result| {
        let outcome = result.map_err(|error| error.to_string()).and_then(|json| {
          let response: serde_json::Value = serde_json::from_str(&json).map_err(|error| error.to_string())?;
          match response.get("exceptionDetails") {
            Some(details) => Err(details["exception"]["description"].as_str().unwrap_or("Picture-in-picture failed").to_string()),
            None => Ok(response["result"]["value"].as_str().unwrap_or_default().to_string()),
          }
        });
        let _ = reply.send(outcome);
      })
    });
    if let Err(error) = started {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

/// «Назад» (step < 0) чи «Вперед» історією вкладки.
pub fn go(webview: &Webview, step: i32) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let _ = core(&platform).and_then(|core| unsafe { if step < 0 { core.GoBack() } else { core.GoForward() } });
  })
}

fn audio(core: &ICoreWebView2_8) -> windows_core::Result<(bool, bool)> {
  let (mut playing, mut muted) = (BOOL::default(), BOOL::default());
  unsafe {
    core.IsDocumentPlayingAudio(&mut playing)?;
    core.IsMuted(&mut muted)?;
  }
  Ok((playing.as_bool(), muted.as_bool()))
}

/// Повідомляє `report(playing, muted)` щоразу, як сторінка починає чи перестає грати звук або його вимикають.
pub fn watch_audio(webview: &Webview, report: impl Fn(bool, bool) + Clone + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let core = core(&platform)?.cast::<ICoreWebView2_8>()?;
      let mut token = 0;
      unsafe {
        core.add_IsDocumentPlayingAudioChanged(&IsDocumentPlayingAudioChangedEventHandler::create(on_audio(report.clone())), &mut token)?;
        core.add_IsMutedChanged(&IsMutedChangedEventHandler::create(on_audio(report)), &mut token)?;
      }
      Ok(())
    };
    let _ = watch();
  })
}

type AudioHandler = Box<dyn FnMut(Option<ICoreWebView2>, Option<IUnknown>) -> windows_core::Result<()>>;

fn on_audio(report: impl Fn(bool, bool) + 'static) -> AudioHandler {
  Box::new(move |sender, _| {
    if let Some(sender) = sender {
      let (playing, muted) = audio(&sender.cast()?)?;
      report(playing, muted);
    }
    Ok(())
  })
}

pub fn set_muted(webview: &Webview, muted: bool, reply: Reply<()>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let result = core(&platform).and_then(|core| unsafe { core.cast::<ICoreWebView2_8>()?.SetIsMuted(muted) });
    let _ = reply.send(result.map_err(|error| error.to_string()));
  })
}

/// Збережений для `origin` дозвіл на автовідтворення.
pub fn autoplay(webview: &Webview, origin: String, reply: Reply<Autoplay>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let request = || -> windows_core::Result<()> {
      let handler = GetNonDefaultPermissionSettingsCompletedHandler::create(Box::new(move |result, settings| {
        let found = result.and_then(|()| find_autoplay(settings, &origin));
        let _ = reply.send(found.map_err(|error| error.to_string()));
        Ok(())
      }));
      unsafe { profile(&platform)?.GetNonDefaultPermissionSettings(&handler) }
    };
    if let Err(error) = request() {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

fn find_autoplay(settings: Option<ICoreWebView2PermissionSettingCollectionView>, origin: &str) -> windows_core::Result<Autoplay> {
  let Some(settings) = settings else {
    return Ok(Autoplay::Default);
  };
  let mut count = 0;
  unsafe { settings.Count(&mut count)? };
  for index in 0..count {
    let setting = unsafe { settings.GetValueAtIndex(index)? };
    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
    let mut state = COREWEBVIEW2_PERMISSION_STATE::default();
    let mut setting_origin = PWSTR::null();
    unsafe {
      setting.PermissionKind(&mut kind)?;
      setting.PermissionState(&mut state)?;
      setting.PermissionOrigin(&mut setting_origin)?;
    }
    let setting_origin = take_pwstr(setting_origin);
    if kind == COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY && setting_origin.trim_end_matches('/') == origin {
      return Ok(Autoplay::from_state(state));
    }
  }
  Ok(Autoplay::Default)
}

/// Зберігає дозвіл для `origin` у профілі; сторінка побачить його після перезавантаження.
pub fn set_autoplay(webview: &Webview, origin: String, autoplay: Autoplay, reply: Reply<()>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let request = || -> windows_core::Result<()> {
      let handler = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
        let _ = reply.send(result.map_err(|error| error.to_string()));
        Ok(())
      }));
      unsafe {
        profile(&platform)?.SetPermissionState(COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY, &HSTRING::from(origin.as_str()), autoplay.state(), &handler)
      }
    };
    if let Err(error) = request() {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}
