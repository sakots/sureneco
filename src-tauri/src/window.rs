#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
pub fn fit(saved: Bounds, areas: &[Bounds]) -> Bounds {
    let areas = areas
        .iter()
        .copied()
        .filter(|area| area.width > 0 && area.height > 0);
    let Some(mut area) = areas.clone().next() else {
        return saved;
    };
    let mut greatest = 0_i64;
    for candidate in areas {
        let width = (i64::from(saved.x) + i64::from(saved.width))
            .min(i64::from(candidate.x) + i64::from(candidate.width))
            - i64::from(saved.x).max(i64::from(candidate.x));
        let height = (i64::from(saved.y) + i64::from(saved.height))
            .min(i64::from(candidate.y) + i64::from(candidate.height))
            - i64::from(saved.y).max(i64::from(candidate.y));
        let overlap = width.max(0) * height.max(0);
        if overlap > greatest {
            greatest = overlap;
            area = candidate;
        }
    }
    let width = saved.width.min(area.width);
    let height = saved.height.min(area.height);
    Bounds {
        x: saved
            .x
            .clamp(area.x, area.x.saturating_add((area.width - width) as i32)),
        y: saved
            .y
            .clamp(area.y, area.y.saturating_add((area.height - height) as i32)),
        width,
        height,
    }
}

pub fn allowed_navigation(url: &url::Url, development: bool) -> bool {
    (development && url.origin().ascii_serialization() == "http://127.0.0.1:5173")
        || (!development
            && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || ((url.scheme() == "http" || url.scheme() == "https")
                    && url.host_str() == Some("tauri.localhost")
                    && url.port().is_none())))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fits_removed_monitor_and_small_work_area() {
        let area = Bounds {
            x: 0,
            y: 0,
            width: 800,
            height: 500,
        };
        assert_eq!(
            fit(
                Bounds {
                    x: 3000,
                    y: -1000,
                    width: 1120,
                    height: 820
                },
                &[area]
            ),
            area
        );
        let second = Bounds {
            x: 800,
            y: 0,
            width: 1000,
            height: 800,
        };
        let saved = Bounds {
            x: 900,
            y: 50,
            width: 600,
            height: 600,
        };
        assert_eq!(fit(saved, &[area, second]), saved);
    }
    #[test]
    fn navigation_is_confined_to_application_origin() {
        for url in ["tauri://localhost/index.html", "http://tauri.localhost/"] {
            assert!(allowed_navigation(&url::Url::parse(url).unwrap(), false));
        }
        for url in [
            "https://example.com",
            "http://tauri.localhost.evil.com",
            "http://127.0.0.1:5173",
        ] {
            assert!(!allowed_navigation(&url::Url::parse(url).unwrap(), false));
        }
        assert!(allowed_navigation(
            &url::Url::parse("http://127.0.0.1:5173").unwrap(),
            true
        ));
    }
    #[test]
    fn ignores_uninitialized_monitor_work_area() {
        let saved = Bounds {
            x: 20,
            y: 20,
            width: 1120,
            height: 820,
        };
        let empty = Bounds {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
        assert_eq!(fit(saved, &[empty]), saved);
    }
}
