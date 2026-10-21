#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Androidアプリの起動に失敗しました");
}
