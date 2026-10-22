// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeToggle } from "../src/renderer/ThemeToggle";

let dark = false;
let listeners: Set<() => void>;
beforeEach(() => {
  localStorage.clear();
  dark = false;
  listeners = new Set();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return dark;
    },
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});
function systemDark(value: boolean) {
  act(() => {
    dark = value;
    listeners.forEach((listener) => listener());
  });
}
it("defaults to system and follows changes, removing its listener on unmount", () => {
  const view = render(<ThemeToggle />);
  expect(screen.getByRole("button", { name: /テーマ：システム/ })).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe("light");
  systemDark(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
  view.unmount();
  expect(listeners.size).toBe(0);
});
it("cycles light, dark, and system; retains the choice across mounts", async () => {
  dark = true;
  const user = userEvent.setup();
  const view = render(<ThemeToggle />);
  await user.click(screen.getByRole("button", { name: /テーマ：システム/ }));
  expect(document.documentElement.dataset.theme).toBe("light");
  systemDark(false);
  systemDark(true);
  expect(document.documentElement.dataset.theme).toBe("light");
  await user.click(screen.getByRole("button", { name: /テーマ：ライト/ }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  view.unmount();
  render(<ThemeToggle />);
  expect(screen.getByRole("button", { name: /テーマ：ダーク/ })).toBeTruthy();
  systemDark(false);
  expect(document.documentElement.dataset.theme).toBe("dark");
  await user.click(screen.getByRole("button", { name: /テーマ：ダーク/ }));
  expect(document.documentElement.dataset.theme).toBe("light");
  systemDark(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
});
it("uses system for an invalid saved value", () => {
  localStorage.setItem("sureneco.theme", "invalid");
  dark = true;
  render(<ThemeToggle />);
  expect(screen.getByRole("button", { name: /テーマ：システム/ })).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe("dark");
});
it("still switches if storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  render(<ThemeToggle />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: /テーマ：システム/ }));
  expect(document.documentElement.dataset.theme).toBe("light");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: /テーマ：ライト/ }));
  expect(document.documentElement.dataset.theme).toBe("dark");
});
