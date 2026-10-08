export interface Settings {
  update_sec: number;
  elapsed_days: number;
  emphasis_sec: number;
  thread_title_regex: string;
  ng_thread_title_regex: string;
  yujinsen_regex: string;
  closed_yujinsen_regex: string;
  url: string;
  ng_words: string[];
  ng_ids: string[];
  ng_watchois: string[];
  allowed_watchois: string[];
  launcher_mode: "default" | "browser" | "application";
  launcher_path: string;
  launcher_args: string[];
  launcher_profile: string;
  launcher_user_data_dir: string;
}
export interface Thread {
  id: string;
  title: string;
  count: number;
  createdAt: number;
}
export interface Post {
  number: number;
  name: string;
  id: string;
  watchoi: string;
  body: string;
  postedAt: number;
}
export interface Recruitment extends Post {
  roomIds: string[];
  threadId: string;
  closed: boolean;
}
export interface SavedState {
  settings: Settings;
  watched: string[];
  cursors: Record<string, number>;
}
export interface Snapshot {
  settings: Settings;
  watched: string[];
  threads: Thread[];
  recruitments: Recruitment[];
  errors: string[];
  refreshing: boolean;
  updatedAt: number | null;
  notificationAvailable: boolean;
}
export interface UpdateState {
  version: string;
  mode: "auto" | "manual" | "disabled";
  status:
    | "idle"
    | "checking"
    | "available"
    | "current"
    | "downloading"
    | "downloaded"
    | "installing"
    | "error"
    | "disabled";
  latestVersion: string | null;
  progress: number;
  error: string | null;
}
export interface Api {
  getUpdateState(): Promise<UpdateState>;
  checkUpdate(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  openRelease(): Promise<void>;
  subscribeUpdate(callback: (state: UpdateState) => void): () => void;
  getSnapshot(): Promise<Snapshot>;
  refresh(): Promise<void>;
  watch(id: string, enabled: boolean): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;
  openThread(id: string, post?: number): Promise<void>;
  copyRoomId(id: string): Promise<void>;
  launchMahjongSoul(id: string): Promise<void>;
  subscribe(callback: (snapshot: Snapshot) => void): () => void;
}
