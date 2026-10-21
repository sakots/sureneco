#[cfg(all(target_os = "android", feature = "desktop"))]
compile_error!("Android requires --no-default-features --features mobile");

#[cfg(feature = "desktop")]
pub mod desktop;
pub mod engine;
pub mod http;
#[cfg(all(target_os = "android", feature = "mobile"))]
mod mobile;
pub mod storage;
pub mod window;
