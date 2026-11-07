//! Послідовний запис сховищ: автозаповнення не чекає диска, явне збереження чекає завершення того самого записувача.

use std::{
  fs,
  path::{Path, PathBuf},
  sync::{mpsc, Mutex},
  thread,
};

type Result = std::result::Result<(), String>;
type Work = Box<dyn FnOnce() -> Result + Send>;

struct Save {
  file: Option<PathBuf>,
  work: Work,
  done: Option<mpsc::Sender<Result>>,
}

struct Worker {
  sender: mpsc::Sender<Save>,
  thread: thread::JoinHandle<()>,
}

#[derive(Default)]
pub(crate) struct SaveQueue {
  worker: Mutex<Option<Worker>>,
}

impl SaveQueue {
  /// Викликати під блокуванням сховища: черга тоді має той самий порядок, що й зміни в пам'яті.
  pub fn save(&self, file: PathBuf, wait: bool, work: impl FnOnce() -> Result + Send + 'static) -> Result {
    let (done, reply) = mpsc::channel();
    {
      let mut worker = self.worker.lock().map_err(|error| error.to_string())?;
      if worker.is_none() {
        let (sender, receiver) = mpsc::channel();
        let thread =
          thread::Builder::new().name("vault-writer".into()).spawn(move || run(receiver)).map_err(|error| error.to_string())?;
        *worker = Some(Worker { sender, thread });
      }
      worker
        .as_ref()
        .expect("writer started")
        .sender
        .send(Save { file: Some(file), work: Box::new(work), done: wait.then_some(done) })
        .map_err(|error| error.to_string())?;
    }
    if wait {
      reply.recv().map_err(|error| error.to_string())?
    } else {
      Ok(())
    }
  }

  /// Бар'єр перед читанням іншого облікового запису чи видаленням його файлів.
  pub fn flush(&self) -> Result {
    let (done, reply) = mpsc::channel();
    {
      let worker = self.worker.lock().map_err(|error| error.to_string())?;
      let Some(worker) = worker.as_ref() else {
        return Ok(());
      };
      worker.sender.send(Save { file: None, work: Box::new(|| Ok(())), done: Some(done) }).map_err(|error| error.to_string())?;
    }
    reply.recv().map_err(|error| error.to_string())?
  }
}

impl Drop for SaveQueue {
  fn drop(&mut self) {
    if let Some(worker) = self.worker.get_mut().unwrap_or_else(|error| error.into_inner()).take() {
      drop(worker.sender);
      let _ = worker.thread.join();
    }
  }
}

fn run(receiver: mpsc::Receiver<Save>) {
  let mut pending = None;
  while let Some(mut save) = pending.take().or_else(|| receiver.recv().ok()) {
    // Кілька ще не початих оновлень used одного файла — досить останнього знімка. Явне збереження й бар'єр
    // ніколи не пропускаються; записи іншого облікового запису не підміняють попередній.
    if save.done.is_none() {
      while let Ok(next) = receiver.try_recv() {
        if next.done.is_none() && next.file == save.file {
          save = next;
        } else {
          pending = Some(next);
          break;
        }
      }
    }
    let result = (save.work)();
    if let Some(done) = save.done {
      let _ = done.send(result);
    } else if let Err(error) = result {
      log::warn!("Не вдалося зберегти використання автозаповнення: {error}");
    }
  }
}

pub(crate) fn atomic_write(file: &Path, bytes: &[u8]) -> Result {
  if let Some(dir) = file.parent() {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
  }
  let temporary = file.with_extension("tmp");
  fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
  fs::rename(&temporary, file).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Arc;

  #[test]
  fn deferred_saves_coalesce_without_overtaking_explicit_saves_or_other_accounts() {
    let queue = SaveQueue::default();
    let (started, running) = mpsc::channel();
    let (release, released) = mpsc::channel();
    queue
      .save("first".into(), false, move || {
        started.send(()).unwrap();
        released.recv().unwrap();
        Ok(())
      })
      .unwrap();
    running.recv().unwrap();
    let saved = Arc::new(Mutex::new(Vec::new()));
    for (file, value) in [("a", 1), ("a", 2), ("b", 3), ("a", 4)] {
      let saved = saved.clone();
      queue
        .save(file.into(), false, move || {
          saved.lock().unwrap().push(value);
          Ok(())
        })
        .unwrap();
    }
    release.send(()).unwrap();
    let explicit = saved.clone();
    queue
      .save("a".into(), true, move || {
        explicit.lock().unwrap().push(5);
        Ok(())
      })
      .unwrap();
    queue.flush().unwrap();
    assert_eq!(*saved.lock().unwrap(), vec![2, 3, 4, 5]);
  }

  #[test]
  fn explicit_save_reports_failure_and_drop_finishes_deferred_work() {
    let saved = Arc::new(Mutex::new(false));
    let queue = SaveQueue::default();
    assert_eq!(queue.save("a".into(), true, || Err("disk full".into())), Err("disk full".into()));
    let final_save = saved.clone();
    queue
      .save("a".into(), false, move || {
        *final_save.lock().unwrap() = true;
        Ok(())
      })
      .unwrap();
    drop(queue);
    assert!(*saved.lock().unwrap());
  }
}
