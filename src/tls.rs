//! Самоподписанный сертификат для работы в локальной сети.
//!
//! Без HTTPS браузер не отдаёт ни микрофон, ни захват экрана: это защищённые
//! возможности, и `http://192.168.…` защищённым контекстом не считается —
//! исключение сделано только для `localhost`. То есть комната, поднятая дома,
//! работала бы у хозяина и ни у кого больше.
//!
//! Настоящий сертификат в локальной сети взять неоткуда: у машины нет ни
//! домена, ни доступа к центру сертификации. Поэтому выписываем свой — на все
//! адреса, по которым к серверу могут обратиться. Браузер один раз покажет
//! предупреждение, после чего всё работает как на обычном сайте.
//!
//! Сертификат живёт рядом с данными сервера и переиспользуется: каждый запуск с
//! новым сертификатом означал бы новое предупреждение у каждого зрителя.

use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};

use rcgen::CertifiedKey;
use tracing::info;

/// Пара «сертификат + ключ» в PEM.
pub struct SelfSigned {
    pub cert_pem: String,
    pub key_pem: String,
}

/// Берёт сертификат из каталога или выписывает новый.
pub fn ensure(dir: &Path) -> std::io::Result<SelfSigned> {
    let cert_path = dir.join("lan-cert.pem");
    let key_path = dir.join("lan-key.pem");

    if let (Ok(cert_pem), Ok(key_pem)) =
        (std::fs::read_to_string(&cert_path), std::fs::read_to_string(&key_path))
    {
        info!("сертификат для локальной сети: {}", cert_path.display());
        return Ok(SelfSigned { cert_pem, key_pem });
    }

    let names = subject_names();
    info!("выписываем сертификат для локальной сети: {}", names.join(", "));

    let CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(names).map_err(std::io::Error::other)?;
    let out = SelfSigned { cert_pem: cert.pem(), key_pem: signing_key.serialize_pem() };

    std::fs::create_dir_all(dir)?;
    std::fs::write(&cert_path, &out.cert_pem)?;
    std::fs::write(&key_path, &out.key_pem)?;
    Ok(out)
}

/// Имена и адреса, по которым к серверу могут прийти. Лишние в списке не
/// мешают: сертификат просто покрывает больше, чем нужно.
fn subject_names() -> Vec<String> {
    let mut names = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    if let Some(ip) = local_ip() {
        names.push(ip.to_string());
    }
    names
}

/// Адрес этой машины в локальной сети. Пакетов сокет не шлёт — соединение без
/// обмена данными нужно только чтобы система выбрала исходящий интерфейс.
pub fn local_ip() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // Адрес недостижим без интернета — и не нужен: важен сам выбор интерфейса.
    socket.connect((Ipv4Addr::new(192, 168, 0, 1), 80)).ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

/// Куда класть сертификат: рядом с данными сервера, а не во временный каталог —
/// иначе он терялся бы при перезагрузке вместе с доверием браузеров.
pub fn state_dir() -> PathBuf {
    std::env::var("STATE_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        std::env::var("HOME").map(|h| PathBuf::from(h).join(".yeruverse")).unwrap_or_default()
    })
}
