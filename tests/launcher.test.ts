import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { defaults, validateSettings } from "../src/core/settings";
vi.mock("electron", () => ({
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn(async () => {}) },
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { clipboard, shell } from "electron";
import { spawn } from "node:child_process";
import { launchMahjongSoul } from "../src/main/launcher";
afterEach(() => vi.resetAllMocks());

it("既定ブラウザーで雀魂を開き、先頭ゼロを保ってIDをコピーする", async () => {
  await launchMahjongSoul("０１２３４", defaults);
  expect(clipboard.writeText).toHaveBeenCalledWith("01234");
  expect(shell.openExternal).toHaveBeenCalledWith(
    "https://game.mahjongsoul.com/",
  );
  expect(spawn).not.toHaveBeenCalled();
  await expect(launchMahjongSoul("invalid", defaults)).rejects.toThrow();
  expect(shell.openExternal).toHaveBeenCalledTimes(1);
});

it.each(["browser", "application"] as const)(
  "%sをシェルを介さず起動し、空白を含む引数を保つ",
  async (mode) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ReturnType<typeof spawn>;
    });
    await launchMahjongSoul("12345", {
      ...defaults,
      launcher_mode: mode,
      launcher_path: "/opt/My App/launcher",
      launcher_profile: "Profile 1",
      launcher_user_data_dir: "/home/example/Browser Data",
      launcher_args: ["-applaunch", "12345", "an argument with spaces"],
    });
    expect(spawn).toHaveBeenCalledWith(
      "/opt/My App/launcher",
      mode === "browser"
        ? [
            "--profile-directory=Profile 1",
            "--user-data-dir=/home/example/Browser Data",
            "https://game.mahjongsoul.com/",
          ]
        : ["-applaunch", "12345", "an argument with spaces"],
      { cwd: "/opt/My App", shell: false, detached: true, stdio: "ignore" },
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  },
);

it("実行ファイルが見つからない場合は起動エラーを返す", async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.emit("error", new Error("ENOENT")));
    return child as unknown as ReturnType<typeof spawn>;
  });
  await expect(
    launchMahjongSoul("12345", {
      ...defaults,
      launcher_mode: "application",
      launcher_path: "/missing/game",
    }),
  ).rejects.toThrow("ENOENT");
  expect(child.unref).not.toHaveBeenCalled();
});

it("既存の設定に起動設定の既定値を補い、不正なパス・引数を拒否する", () => {
  const {
    launcher_mode,
    launcher_path,
    launcher_args,
    launcher_profile,
    launcher_user_data_dir,
    ...old
  } = defaults;
  expect(validateSettings(old)).toEqual(defaults);
  for (const change of [
    { launcher_mode: "unknown" },
    { launcher_mode: "application", launcher_path: "" },
    { launcher_mode: "browser", launcher_path: "relative/chrome.exe" },
    { launcher_path: "x\0y" },
    { launcher_profile: "../Profile 1" },
    { launcher_user_data_dir: "relative" },
    { launcher_args: "-applaunch 12345" },
    { launcher_args: [12345] },
    { launcher_args: ["bad\0argument"] },
  ])
    expect(() => validateSettings({ ...defaults, ...change })).toThrow();
  expect(
    validateSettings({
      ...defaults,
      launcher_mode: "browser",
      launcher_path:
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    }).launcher_path,
  ).toContain("Program Files");
});
