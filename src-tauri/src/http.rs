use encoding_rs::{SHIFT_JIS, UTF_8};
use reqwest::{blocking::Client, redirect::Policy};
use std::{io::Read, time::Duration};
use url::Url;
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;

pub fn allowed_url(input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|error| error.to_string())?;
    let host = url.host_str().unwrap_or("");
    let host_ok = ["5ch.io", "5ch.net"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    let path: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
    let board_ok = path.first().is_some_and(|board| {
        !board.is_empty()
            && board
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
    });
    let file_ok = (path.len() == 2 && path[1] == "subject.txt")
        || (path.len() == 3
            && path[1] == "dat"
            && path[2].strip_suffix(".dat").is_some_and(|id| {
                (9..=11).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_digit())
            }));
    if url.scheme() != "https"
        || !host_ok
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !board_ok
        || !file_ok
    {
        return Err("取得URLが不正です。".into());
    }
    Ok(url)
}

pub fn fetch(input: &str) -> Result<String, String> {
    let url = allowed_url(input)?;
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("sureneco/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .header("Accept", "text/plain")
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let utf8 = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.to_ascii_lowercase().contains("utf-8") || v.to_ascii_lowercase().contains("utf8")
        });
    let mut bytes = Vec::new();
    response
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    decode(&bytes, utf8)
}

pub fn decode(bytes: &[u8], utf8: bool) -> Result<String, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("取得データが5MiBを超えています。".into());
    }
    Ok(if utf8 { UTF_8 } else { SHIFT_JIS }
        .decode(bytes)
        .0
        .into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confines_requests_to_board_data() {
        assert!(allowed_url("https://egg.5ch.io/mj/subject.txt").is_ok());
        assert!(allowed_url("https://egg.5ch.net/mj/dat/1786524360.dat").is_ok());
        for url in [
            "http://egg.5ch.io/mj/subject.txt",
            "https://5ch.io.evil.com/mj/subject.txt",
            "https://egg.5ch.io/mj/subject.txt?x=1",
            "https://egg.5ch.io/mj/../secret",
            "https://egg.5ch.io/mj/dat/not-a-thread.dat",
        ] {
            assert!(allowed_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn decodes_and_limits_response() {
        let encoded = SHIFT_JIS.encode("雀魂").0;
        assert_eq!(decode(&encoded, false).unwrap(), "雀魂");
        assert_eq!(decode("雀魂".as_bytes(), true).unwrap(), "雀魂");
        assert!(decode(&vec![0; MAX_BYTES as usize + 1], false).is_err());
    }
}
