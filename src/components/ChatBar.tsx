"use client";

import { SendHorizontal } from "lucide-react";
import { useId, useState } from "react";

const MAX_LENGTH = 1000;

type Status = "idle" | "waiting" | "error" | "toolong";

const MESSAGES: Record<"error" | "toolong", string> = {
  error: "Не получилось ответить, попробуй ещё раз.",
  toolong: "Сообщение длиннее 1000 символов. Сократи его.",
};

/**
 * Поле вопроса внизу ленты (П-37–П-45), только у владельца.
 * Пустое сообщение отправить нельзя, пока ждём ответ, ввод заблокирован,
 * при ошибке текст остаётся для повторной отправки.
 */
export function ChatBar({ onAsk }: { onAsk: (question: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const msgId = useId();

  const empty = text.trim().length === 0;
  const waiting = status === "waiting";
  const blocked = empty || waiting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    if (text.length > MAX_LENGTH) {
      setStatus("toolong");
      return;
    }
    setStatus("waiting");
    const ok = await onAsk(text.trim());
    if (ok) {
      setText("");
      setStatus("idle");
    } else {
      setStatus("error");
    }
  };

  const message = status === "error" || status === "toolong" ? MESSAGES[status] : null;

  return (
    <form className="chat" onSubmit={submit} aria-label="Вопрос по корейскому">
      <div className="chat__inner">
        {message ? (
          <p className="chat__msg" id={msgId} role="alert">
            {message}
          </p>
        ) : null}
        <div className="chat__row">
          <input
            className="chat__input"
            type="text"
            enterKeyHint="send"
            autoComplete="off"
            aria-label="Вопрос по корейскому"
            aria-describedby={message ? msgId : undefined}
            aria-busy={waiting}
            placeholder="Спроси: «объясни -거든»"
            value={text}
            disabled={waiting}
            onChange={(e) => {
              setText(e.target.value);
              if (status === "error" || status === "toolong") setStatus("idle");
            }}
          />
          <button
            type="submit"
            className="chat__send"
            aria-label={waiting ? "Ответ готовится" : "Отправить"}
            aria-disabled={blocked}
          >
            {waiting ? (
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <SendHorizontal size={22} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
        </div>
        <span className="sr-only" aria-live="polite">
          {waiting ? "Ответ готовится" : ""}
        </span>
      </div>
    </form>
  );
}
