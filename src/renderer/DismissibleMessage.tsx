import { useEffect, useState, type ReactNode } from "react";

type MessageTone = "info" | "success" | "error";

export function DismissibleMessage({
  message,
  tone = "info",
  onDismiss,
  action,
}: {
  message: string;
  tone?: MessageTone;
  onDismiss?: () => void;
  action?: ReactNode;
}) {
  const [dismissedMessage, setDismissedMessage] = useState<string | null>(null);
  useEffect(() => setDismissedMessage(null), [message]);
  if (dismissedMessage === message) return null;
  return (
    <div
      className={`message dismissible-message${tone === "info" ? "" : ` ${tone}`}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="dismissible-message-content">{message}</span>
      {action}
      <button
        type="button"
        className="dismissible-message-close"
        aria-label="通知を閉じる"
        onClick={() => {
          setDismissedMessage(message);
          onDismiss?.();
        }}
      >
        閉じる
      </button>
    </div>
  );
}

export function DismissibleMessageList({
  messages,
  tone = "info",
}: {
  messages: readonly string[];
  tone?: MessageTone;
}) {
  if (messages.length === 0) return null;
  const occurrences = new Map<string, number>();
  return (
    <>
      {messages.map((message) => {
        const occurrence = occurrences.get(message) ?? 0;
        occurrences.set(message, occurrence + 1);
        return (
          <DismissibleMessage
            key={`${occurrence}:${message}`}
            message={message}
            tone={tone}
          />
        );
      })}
    </>
  );
}
