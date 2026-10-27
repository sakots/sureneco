// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import {
  DismissibleMessage,
  DismissibleMessageList,
} from "../src/renderer/DismissibleMessage";

afterEach(cleanup);

it("選んだ案内だけを閉じ、別のエラーは表示したままにする", async () => {
  render(
    <>
      <DismissibleMessage message="停止したスレッドA" />
      <DismissibleMessage message="更新できなかった処理B" tone="error" />
    </>,
  );
  const user = userEvent.setup();
  await user.click(
    within(screen.getByRole("status")).getByRole("button", {
      name: "通知を閉じる",
    }),
  );
  expect(screen.queryByText("停止したスレッドA")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain(
    "更新できなかった処理B",
  );
});

it("別の案内が増減しても閉じた通知を復活させず、解消後の再発は表示する", async () => {
  const { rerender } = render(
    <DismissibleMessageList messages={["案内A", "案内B", "案内C"]} />,
  );
  const user = userEvent.setup();
  await user.click(
    within(screen.getByText("案内B").closest('[role="status"]')!).getByRole(
      "button",
      { name: "通知を閉じる" },
    ),
  );
  rerender(<DismissibleMessageList messages={["案内B", "案内C", "案内D"]} />);
  expect(screen.queryByText("案内B")).toBeNull();
  expect(screen.getByText("案内C")).toBeTruthy();
  expect(screen.getByText("案内D")).toBeTruthy();
  rerender(<DismissibleMessageList messages={[]} />);
  rerender(<DismissibleMessageList messages={["案内B"]} />);
  expect(screen.getByText("案内B")).toBeTruthy();
});

it("閉じた通知の内容が変われば表示し、以前の内容が再発しても表示する", async () => {
  const { rerender } = render(
    <DismissibleMessage message="失敗A" tone="error" />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  rerender(<DismissibleMessage message="失敗B" tone="error" />);
  expect(screen.getByText("失敗B")).toBeTruthy();
  rerender(<DismissibleMessage message="失敗A" tone="error" />);
  expect(screen.getByText("失敗A")).toBeTruthy();
});

it("キーボードでも閉じられ、フォームを送信しない", async () => {
  let submissions = 0;
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        ++submissions;
      }}
    >
      <DismissibleMessage message="入力に誤りがあります" tone="error" />
      <button type="submit">保存</button>
    </form>,
  );
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "通知を閉じる" }),
  );
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(submissions).toBe(0);
});

it("同じ文面の通知が複数あっても個別に閉じられる", async () => {
  const messages = ["同じ取得失敗", "同じ取得失敗"];
  const { rerender } = render(
    <DismissibleMessageList messages={messages} tone="error" />,
  );
  const user = userEvent.setup();
  await user.click(
    within(screen.getAllByRole("alert")[0]).getByRole("button", {
      name: "通知を閉じる",
    }),
  );
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  rerender(<DismissibleMessageList messages={[...messages]} tone="error" />);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});
