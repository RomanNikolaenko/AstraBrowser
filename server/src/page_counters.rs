//! Лічильники блокувальників: мережевий запит блокується одразу, інтерфейс отримує підсумок серії раз на 100 мс.
//! Новий документ скидає підсумок одразу; відкладена звістка попереднього документа вже не може його замінити.

use std::{
  collections::{BTreeSet, HashMap},
  sync::{Arc, LazyLock, Mutex, Weak},
  time::Duration,
};

use tauri::{AppHandle, Manager};

use crate::tracking::Category;

const INTERVAL: Duration = Duration::from_millis(100);

pub enum Blocked {
  Reset,
  Ad,
  Tracker(Category, String),
}

/// Лише те, що змінилося від попередньої звістки; на новому документі — обидва порожні значення.
#[derive(Debug, PartialEq, Eq)]
pub struct Snapshot {
  pub ads: Option<u32>,
  pub trackers: Option<Vec<(Category, String)>>,
}

#[derive(Default)]
struct Pending {
  ads: u32,
  trackers: BTreeSet<(Category, String)>,
  ads_changed: bool,
  trackers_changed: bool,
  generation: u64,
  scheduled: Option<u64>,
  closed: bool,
}

enum Update {
  Reset(Snapshot),
  Schedule(u64),
  None,
}

impl Pending {
  fn record(&mut self, blocked: Blocked) -> Update {
    if self.closed {
      return Update::None;
    }
    match blocked {
      Blocked::Reset => {
        self.generation = self.generation.wrapping_add(1);
        self.scheduled = None;
        self.ads = 0;
        self.trackers.clear();
        self.ads_changed = false;
        self.trackers_changed = false;
        return Update::Reset(Snapshot { ads: Some(0), trackers: Some(Vec::new()) });
      }
      Blocked::Ad => {
        self.ads = self.ads.saturating_add(1);
        self.ads_changed = true;
      }
      Blocked::Tracker(category, host) => {
        if !self.trackers.insert((category, host)) {
          return Update::None;
        }
        self.trackers_changed = true;
      }
    }
    if self.scheduled.is_some() {
      return Update::None;
    }
    self.generation = self.generation.wrapping_add(1);
    self.scheduled = Some(self.generation);
    Update::Schedule(self.generation)
  }

  fn take(&mut self, generation: u64) -> Option<Snapshot> {
    if self.closed || self.scheduled != Some(generation) {
      return None;
    }
    self.scheduled = None;
    let snapshot = Snapshot {
      ads: self.ads_changed.then_some(self.ads),
      trackers: self.trackers_changed.then(|| self.trackers.iter().cloned().collect()),
    };
    self.ads_changed = false;
    self.trackers_changed = false;
    Some(snapshot)
  }

  fn close(&mut self) {
    self.closed = true;
    self.scheduled = None;
    self.trackers.clear();
  }
}

struct Shared {
  pending: Mutex<Pending>,
  report: Box<dyn Fn(Snapshot) + Send + Sync>,
}

static REPORTERS: LazyLock<Mutex<HashMap<String, Weak<Shared>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Власник живе в обробниках webview; таймери тримають лише Weak і не подовжують життя закритої сторінки.
pub struct Reporter {
  app: AppHandle,
  label: String,
  shared: Arc<Shared>,
}

impl Reporter {
  pub fn new(app: AppHandle, label: String, report: impl Fn(Snapshot) + Send + Sync + 'static) -> Self {
    let shared = Arc::new(Shared { pending: Mutex::new(Pending::default()), report: Box::new(report) });
    let previous = REPORTERS.lock().unwrap().insert(label.clone(), Arc::downgrade(&shared));
    // Навіть якщо мітку перевикористали, стара сторінка більше не може надсилати звістки до неї.
    if let Some(previous) = previous.and_then(|previous| previous.upgrade()) {
      previous.pending.lock().unwrap().close();
    }
    Self { app, label, shared }
  }

  /// Викликається на головному потоці після того, як блокувальник уже відповів на мережевий запит.
  pub fn record(&self, blocked: Blocked) {
    let generation = {
      let mut pending = self.shared.pending.lock().unwrap();
      match pending.record(blocked) {
        Update::Reset(snapshot) => {
          (self.shared.report)(snapshot);
          return;
        }
        Update::Schedule(generation) => generation,
        Update::None => return,
      }
    };
    let shared = Arc::downgrade(&self.shared);
    let (app, label) = (self.app.clone(), self.label.clone());
    tauri::async_runtime::spawn(async move {
      tokio::time::sleep(INTERVAL).await;
      let owner = app.clone();
      // Скидання й надсилання — в одному потоці з навігацією: стара звістка не обжене Reset.
      let _ = app.run_on_main_thread(move || {
        let Some(shared) = shared.upgrade() else { return };
        let mut pending = shared.pending.lock().unwrap();
        if owner.get_webview(&label).is_none() {
          pending.close();
          return;
        }
        if let Some(snapshot) = pending.take(generation) {
          // Замок лишається й на час emit: page_close з іншого потоку не повернеться раніше за стару звістку.
          (shared.report)(snapshot);
        }
      });
    });
  }
}

impl Drop for Reporter {
  fn drop(&mut self) {
    self.shared.pending.lock().unwrap().close();
    let mut reporters = REPORTERS.lock().unwrap();
    if reporters.get(&self.label).is_some_and(|entry| entry.ptr_eq(&Arc::downgrade(&self.shared))) {
      reporters.remove(&self.label);
    }
  }
}

/// Закрита вкладка може ще тримати webview до кінця завантаження: її лічильники вже не потрібні.
pub fn close(label: &str) {
  let reporter = REPORTERS.lock().unwrap().remove(label).and_then(|reporter| reporter.upgrade());
  if let Some(reporter) = reporter {
    reporter.pending.lock().unwrap().close();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scheduled(update: Update) -> u64 {
    let Update::Schedule(generation) = update else { panic!("expected one scheduled report") };
    generation
  }

  #[test]
  fn a_burst_reports_the_complete_counts_once_including_the_last_request() {
    let mut pending = Pending::default();
    let generation = scheduled(pending.record(Blocked::Ad));
    for _ in 1..500 {
      assert!(matches!(pending.record(Blocked::Ad), Update::None));
    }
    for host in ["a.test", "b.test", "a.test"] {
      assert!(matches!(pending.record(Blocked::Tracker(Category::Tracking, host.into())), Update::None));
    }
    assert_eq!(
      pending.take(generation),
      Some(Snapshot {
        ads: Some(500),
        trackers: Some(vec![(Category::Tracking, "a.test".into()), (Category::Tracking, "b.test".into())]),
      })
    );
    assert_eq!(pending.take(generation), None);
    assert!(matches!(pending.record(Blocked::Tracker(Category::Tracking, "a.test".into())), Update::None));

    let next = scheduled(pending.record(Blocked::Ad));
    assert_eq!(pending.take(generation), None);
    assert_eq!(pending.take(next), Some(Snapshot { ads: Some(501), trackers: None }));
  }

  #[test]
  fn navigation_resets_immediately_and_late_reports_do_not_consume_the_new_document() {
    let mut pending = Pending::default();
    let previous = scheduled(pending.record(Blocked::Tracker(Category::Social, "old.test".into())));
    pending.record(Blocked::Ad);
    let Update::Reset(reset) = pending.record(Blocked::Reset) else { panic!("navigation must reset immediately") };
    assert_eq!(reset, Snapshot { ads: Some(0), trackers: Some(Vec::new()) });
    let next = scheduled(pending.record(Blocked::Tracker(Category::Tracking, "new.test".into())));
    pending.record(Blocked::Ad);
    assert_eq!(pending.take(previous), None);
    assert_eq!(
      pending.take(next),
      Some(Snapshot { ads: Some(1), trackers: Some(vec![(Category::Tracking, "new.test".into())]) })
    );
  }

  #[test]
  fn closing_a_tab_discards_pending_and_late_updates() {
    let mut pending = Pending::default();
    let generation = scheduled(pending.record(Blocked::Ad));
    pending.close();
    assert_eq!(pending.take(generation), None);
    assert!(matches!(pending.record(Blocked::Ad), Update::None));
    assert!(matches!(pending.record(Blocked::Reset), Update::None));
    assert!(matches!(pending.record(Blocked::Tracker(Category::Tracking, "late.test".into())), Update::None));
  }
}
