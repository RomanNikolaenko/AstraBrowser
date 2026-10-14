//! DNS через HTTPS у Linux. Свого DoH WebKitGTK не має: назви сайтів він з'ясовує через DNS системи. Тож сайти йдуть
//! через проксі SOCKS5 у самому браузері (127.0.0.1, з паролем — іншим програмам комп'ютера він не відкритий): WebKit
//! передає йому назву сайту, а проксі з'ясовує адресу запитом DoH до вибраного постачальника (RFC 8484) і з'єднує.
//! Режими — як у Windows (dns.rs): «Підвищений» — DoH, а якщо постачальник не відповідає, DNS системи; «Максимальний» —
//! лише DoH; решта — без проксі, DNS системи. На відміну від Windows, новий вибір діє одразу.
//!
//! Адреси з кешу живуть, скільки каже постачальник (від 30 с до 5 хв). Назви цього комп'ютера (localhost) і самі
//! IP-адреси — без DoH. WebRTC іде повз проксі, як і запити самого браузера (значки, переклад).

use std::{
  collections::HashMap,
  io::{self, Read, Write},
  net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
  sync::{LazyLock, Mutex, OnceLock, RwLock},
  thread,
  time::{Duration, Instant},
};

use tauri::Webview;
use webkit2gtk::{NetworkProxyMode, NetworkProxySettings, WebViewExt, WebsiteDataManagerExt};

/// Звідки й як брати адреси: шаблон DoH постачальника і чи можна, коли він не відповідає, спитати DNS системи.
#[derive(Clone)]
struct Resolver {
  template: String,
  fallback: bool,
}

/// Проксі, що вже працює: порт і пароль, з яким до нього можна.
struct Proxy {
  port: u16,
  password: String,
}

/// Логін проксі (пароль — випадковий на кожен запуск).
const USER: &str = "astra";
/// Скільки чекати на постачальника DoH і на з'єднання з сайтом.
const DOH_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Скільки тримати адреси в кеші — у межах того, що каже постачальник.
const MIN_TTL: Duration = Duration::from_secs(30);
const MAX_TTL: Duration = Duration::from_secs(5 * 60);
/// Від скількох записів кеш позбувається прострочених: інакше він ріс би з кожним новим сайтом.
const CACHE_PRUNE_AT: usize = 512;

static RESOLVER: RwLock<Option<Resolver>> = RwLock::new(None);
static PROXY: OnceLock<Option<Proxy>> = OnceLock::new();
/// Адреси імені й до коли вони чинні.
type Cached = (Vec<IpAddr>, Instant);

static CACHE: LazyLock<Mutex<HashMap<String, Cached>>> = LazyLock::new(Mutex::default);

/// Новий вибір DNS: з DoH — проксі (запускається, якщо ще не працює), без нього — DNS системи. Сторінкам його ставить
/// [`apply`].
pub fn configure(settings: &crate::dns::Settings) {
  let resolver = settings.doh_template().map(|(template, fallback)| Resolver { template, fallback });
  if resolver.is_some() {
    PROXY.get_or_init(start);
  }
  if let Ok(mut current) = RESOLVER.write() {
    *current = resolver;
  }
  if let Ok(mut cache) = CACHE.lock() {
    cache.clear();
  }
}

/// Проксі для WebKit, якщо зараз DNS — через HTTPS.
fn proxy_uri() -> Option<String> {
  RESOLVER.read().ok()?.as_ref()?;
  let proxy = PROXY.get()?.as_ref()?;
  Some(format!("socks5://{USER}:{}@127.0.0.1:{}", proxy.password, proxy.port))
}

/// Ставить сторінці (її профілю даних WebKit) проксі з DoH чи повертає налаштування системи.
pub fn apply(webview: &Webview) -> tauri::Result<()> {
  let uri = proxy_uri();
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let Some(data) = view.website_data_manager() else {
      return;
    };
    match &uri {
      Some(uri) => {
        // Сам комп'ютер — напряму: проксі тут ні до чого.
        let mut settings = NetworkProxySettings::new(Some(uri), &["localhost", "127.0.0.0/8", "::1"]);
        data.set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut settings));
      }
      None => data.set_network_proxy_settings(NetworkProxyMode::Default, None),
    }
  })
}

fn start() -> Option<Proxy> {
  let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).inspect_err(|error| log::warn!("DoH: проксі не запустився: {error}")).ok()?;
  let port = listener.local_addr().ok()?.port();
  let mut secret = [0u8; 16];
  getrandom::fill(&mut secret).ok()?;
  let password: String = secret.iter().map(|byte| format!("{byte:02x}")).collect();
  let expected = password.clone();
  thread::spawn(move || {
    for client in listener.incoming().flatten() {
      let expected = expected.clone();
      thread::spawn(move || {
        let _ = serve(client, &expected);
      });
    }
  });
  log::info!("DoH: проксі на 127.0.0.1:{port}");
  Some(Proxy { port, password })
}

// --- SOCKS5 (RFC 1928, пароль — RFC 1929) ---

fn read_bytes(stream: &mut TcpStream, count: usize) -> io::Result<Vec<u8>> {
  let mut bytes = vec![0; count];
  stream.read_exact(&mut bytes)?;
  Ok(bytes)
}

/// Відповідь на запит з'єднання: `code` 0 — гаразд, інакше чому ні.
fn reply(stream: &mut TcpStream, code: u8) -> io::Result<()> {
  stream.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0])
}

fn serve(mut client: TcpStream, password: &str) -> io::Result<()> {
  client.set_read_timeout(Some(CONNECT_TIMEOUT))?;
  let greeting = read_bytes(&mut client, 2)?;
  let methods = read_bytes(&mut client, usize::from(greeting[1]))?;
  // Лише з логіном і паролем: інші програми комп'ютера пароля не знають.
  if greeting[0] != 5 || !methods.contains(&2) {
    client.write_all(&[5, 0xFF])?;
    return Ok(());
  }
  client.write_all(&[5, 2])?;
  let version = read_bytes(&mut client, 2)?;
  let user = read_bytes(&mut client, usize::from(version[1]))?;
  let length = read_bytes(&mut client, 1)?;
  let given = read_bytes(&mut client, usize::from(length[0]))?;
  let accepted = version[0] == 1 && user == USER.as_bytes() && given == password.as_bytes();
  client.write_all(&[1, if accepted { 0 } else { 1 }])?;
  if !accepted {
    return Ok(());
  }

  let request = read_bytes(&mut client, 4)?;
  let host = match request[3] {
    1 => Ipv4Addr::from(<[u8; 4]>::try_from(read_bytes(&mut client, 4)?).unwrap_or_default()).to_string(),
    4 => Ipv6Addr::from(<[u8; 16]>::try_from(read_bytes(&mut client, 16)?).unwrap_or_default()).to_string(),
    3 => {
      let length = read_bytes(&mut client, 1)?;
      String::from_utf8_lossy(&read_bytes(&mut client, usize::from(length[0]))?).into_owned()
    }
    _ => return reply(&mut client, 8),
  };
  let port = read_bytes(&mut client, 2)?;
  let port = u16::from_be_bytes([port[0], port[1]]);
  // Лише з'єднання TCP (CONNECT).
  if request[0] != 5 || request[1] != 1 {
    return reply(&mut client, 7);
  }
  let Ok(addresses) = resolve(&host) else {
    return reply(&mut client, 4);
  };
  let Some(server) = addresses.into_iter().find_map(|ip| TcpStream::connect_timeout(&SocketAddr::new(ip, port), CONNECT_TIMEOUT).ok())
  else {
    return reply(&mut client, 5);
  };
  reply(&mut client, 0)?;
  client.set_read_timeout(None)?;
  let _ = server.set_nodelay(true);

  // Далі — байти в обидва боки, доки одна зі сторін не закриє з'єднання.
  let (mut upload_from, mut upload_to) = (client.try_clone()?, server.try_clone()?);
  let upload = thread::spawn(move || {
    let _ = io::copy(&mut upload_from, &mut upload_to);
    let _ = upload_to.shutdown(Shutdown::Write);
  });
  let (mut download_from, mut download_to) = (server, client);
  let _ = io::copy(&mut download_from, &mut download_to);
  let _ = download_to.shutdown(Shutdown::Write);
  let _ = upload.join();
  Ok(())
}

// --- Адреси ---

/// Адреси сайту `host`: IP — як є, localhost — від системи, решта — через DoH (з кешем).
fn resolve(host: &str) -> io::Result<Vec<IpAddr>> {
  let host = host.trim_end_matches('.').to_ascii_lowercase();
  if let Ok(ip) = host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
    return Ok(vec![ip]);
  }
  let resolver = RESOLVER.read().ok().and_then(|resolver| resolver.clone());
  let Some(resolver) = resolver.filter(|_| host != "localhost" && !host.ends_with(".localhost")) else {
    return system(&host);
  };
  if let Some(addresses) = CACHE.lock().ok().and_then(|cache| cache.get(&host).filter(|(_, until)| *until > Instant::now()).map(|(addresses, _)| addresses.clone())) {
    return Ok(addresses);
  }
  match lookup(&resolver.template, &host) {
    Ok((addresses, ttl)) => {
      if addresses.is_empty() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "no such host"));
      }
      if let Ok(mut cache) = CACHE.lock() {
        if cache.len() >= CACHE_PRUNE_AT {
          let now = Instant::now();
          cache.retain(|_, (_, until)| *until > now);
        }
        cache.insert(host, (addresses.clone(), Instant::now() + ttl.clamp(MIN_TTL, MAX_TTL)));
      }
      Ok(addresses)
    }
    Err(error) if resolver.fallback => {
      log::warn!("DoH: постачальник не відповів ({error}) — DNS системи");
      system(&host)
    }
    Err(error) => Err(io::Error::other(error)),
  }
}

fn system(host: &str) -> io::Result<Vec<IpAddr>> {
  Ok((host, 0).to_socket_addrs()?.map(|address| address.ip()).collect())
}

/// Адреси IPv4 і IPv6 від постачальника (обидва запити разом) і скільки їм жити. Спершу IPv4: він є скрізь.
fn lookup(template: &str, host: &str) -> Result<(Vec<IpAddr>, Duration), String> {
  let (v4, v6) = thread::scope(|scope| {
    let v6 = scope.spawn(|| ask(template, host, 28));
    (ask(template, host, 1), v6.join().unwrap_or_else(|_| Err("DoH".into())))
  });
  // Без IPv6 сайт працює й так, а без відповіді на IPv4 — відповідь має бути хоч на IPv6.
  let (mut addresses, mut ttl) = match (v4, &v6) {
    (Ok(v4), _) => v4,
    (Err(_), Ok(_)) => (Vec::new(), MAX_TTL),
    (Err(error), Err(_)) => return Err(error),
  };
  if let Ok((more, more_ttl)) = v6 {
    addresses.extend(more);
    ttl = ttl.min(more_ttl);
  }
  Ok((addresses, ttl))
}

/// Один запит DoH (RFC 8484, POST): записи типу `kind` (1 — A, 28 — AAAA).
fn ask(template: &str, host: &str, kind: u16) -> Result<(Vec<IpAddr>, Duration), String> {
  let url = template.strip_suffix("{?dns}").unwrap_or(template);
  let message = query(host, kind).ok_or("bad host name")?;
  let body = agent()
    .post(url)
    .header("content-type", "application/dns-message")
    .header("accept", "application/dns-message")
    .send(&message[..])
    .map_err(|error| error.to_string())?
    .body_mut()
    .with_config()
    .limit(64 * 1024)
    .read_to_vec()
    .map_err(|error| error.to_string())?;
  answers(&body).ok_or_else(|| "bad DNS answer".into())
}

fn agent() -> &'static ureq::Agent {
  static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
  AGENT.get_or_init(|| ureq::Agent::config_builder().timeout_global(Some(DOH_TIMEOUT)).build().into())
}

/// Запит DNS про записи типу `kind` для `host` (id 0, як радить RFC 8484 для кешування).
fn query(host: &str, kind: u16) -> Option<Vec<u8>> {
  let mut packet = vec![0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for label in host.split('.') {
    if label.is_empty() || label.len() > 63 {
      return None;
    }
    packet.push(label.len() as u8);
    packet.extend_from_slice(label.as_bytes());
  }
  packet.push(0);
  packet.extend_from_slice(&kind.to_be_bytes());
  packet.extend_from_slice(&1u16.to_be_bytes());
  Some(packet)
}

/// Адреси з відповіді DNS і найменший їхній TTL. Немає такого сайту (NXDOMAIN) — порожньо.
fn answers(packet: &[u8]) -> Option<(Vec<IpAddr>, Duration)> {
  let number = |at: usize| packet.get(at..at + 2).map(|bytes| usize::from(u16::from_be_bytes([bytes[0], bytes[1]])));
  if packet.get(3)? & 0x0F != 0 {
    return Some((Vec::new(), MIN_TTL));
  }
  let (questions, records) = (number(4)?, number(6)?);
  let mut at = 12;
  for _ in 0..questions {
    at = skip_name(packet, at)? + 4;
  }
  let (mut addresses, mut ttl) = (Vec::new(), MAX_TTL);
  for _ in 0..records {
    at = skip_name(packet, at)?;
    let kind = number(at)?;
    let seconds = u32::from_be_bytes(packet.get(at + 4..at + 8)?.try_into().ok()?);
    let length = number(at + 8)?;
    let data = packet.get(at + 10..at + 10 + length)?;
    let address = match (kind, length) {
      (1, 4) => Some(IpAddr::from(<[u8; 4]>::try_from(data).ok()?)),
      (28, 16) => Some(IpAddr::from(<[u8; 16]>::try_from(data).ok()?)),
      _ => None,
    };
    if let Some(address) = address {
      addresses.push(address);
      ttl = ttl.min(Duration::from_secs(u64::from(seconds)));
    }
    at += 10 + length;
  }
  Some((addresses, ttl))
}

/// Позиція одразу за назвою в повідомленні DNS (зі стисненням — посиланням на назву раніше).
fn skip_name(packet: &[u8], mut at: usize) -> Option<usize> {
  loop {
    let length = *packet.get(at)?;
    if length & 0xC0 == 0xC0 {
      return Some(at + 2);
    }
    if length == 0 {
      return Some(at + 1);
    }
    at += 1 + usize::from(length);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn builds_queries_and_reads_answers() {
    assert_eq!(
      query("a.bc", 1),
      Some(vec![0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, b'a', 2, b'b', b'c', 0, 0, 1, 0, 1])
    );
    assert_eq!(query("bad..host", 1), None);
    // Відповідь: питання a.bc, CNAME (стиснена назва) і дві адреси A з різним TTL.
    let mut packet = vec![0, 0, 0x81, 0x80, 0, 1, 0, 3, 0, 0, 0, 0];
    packet.extend_from_slice(&[1, b'a', 2, b'b', b'c', 0, 0, 1, 0, 1]);
    packet.extend_from_slice(&[0xC0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, 2, 0xC0, 14]);
    packet.extend_from_slice(&[0xC0, 12, 0, 1, 0, 1, 0, 0, 1, 0, 0, 4, 1, 2, 3, 4]);
    packet.extend_from_slice(&[0xC0, 12, 0, 1, 0, 1, 0, 0, 0, 90, 0, 4, 5, 6, 7, 8]);
    let (addresses, ttl) = answers(&packet).expect("answers");
    assert_eq!(addresses, [IpAddr::from([1, 2, 3, 4]), IpAddr::from([5, 6, 7, 8])]);
    assert_eq!(ttl, Duration::from_secs(90));
    // Немає такого сайту.
    let mut missing = packet.clone();
    missing[3] = 0x83;
    assert_eq!(answers(&missing), Some((Vec::new(), MIN_TTL)));
  }
}
