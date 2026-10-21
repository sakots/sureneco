fn main() {
    #[cfg(any(feature = "desktop", feature = "mobile"))]
    tauri_build::build();
}
