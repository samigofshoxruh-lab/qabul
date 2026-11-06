import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { ErrorNote } from "./ui";
import { fullTime, shortTime } from "../lib/format";
import { errorText, supabase } from "../lib/supabase";
import { SUPPORT_CHANGED } from "../lib/support";
import type { SupportMessage } from "../lib/types";

const POLL_MS = 8_000;

interface Props {
  workspaceId: string;
  asPlatform: boolean;
  /** Текст, подставленный кнопкой быстрого запроса. Меняется вместе с ключом, чтобы один текст можно было выбрать снова. */
  preset?: { text: string; key: number } | null;
  /** Обновляется снаружи после автоматического сообщения, например о продлении. */
  reloadKey?: number;
  onActivity?: () => void;
  emptyText: string;
}

export function SupportChat({ workspaceId, asPlatform, preset, reloadKey, onActivity, emptyText }: Props) {
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const knownCount = useRef<number | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("support_messages").select("*").eq("workspace_id", workspaceId).order("created_at");
    if (e) {
      setError(`Не удалось загрузить переписку: ${e.message}`);
      return;
    }
    setError("");
    setMessages(data as SupportMessage[]);
    // Новое сообщение могло прийти вместе с продлением: сайт сразу перечитает срок.
    if (knownCount.current !== null && knownCount.current !== data.length) {
      window.dispatchEvent(new Event(SUPPORT_CHANGED));
    }
    knownCount.current = data.length;
    const incoming = asPlatform ? "owner" : "platform";
    if ((data as SupportMessage[]).some((m) => m.sender === incoming && !m.read_at)) {
      await supabase.rpc("support_mark_read", { p_workspace: workspaceId, p_as_platform: asPlatform });
      window.dispatchEvent(new Event(SUPPORT_CHANGED));
      onActivity?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, asPlatform]);

  useEffect(() => {
    load();
    const live = supabase
      .channel(`support-${workspaceId}-${asPlatform}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "support_messages", filter: `workspace_id=eq.${workspaceId}` }, () => load())
      .subscribe();
    const timer = setInterval(load, POLL_MS);
    return () => {
      supabase.removeChannel(live);
      clearInterval(timer);
    };
  }, [workspaceId, asPlatform, load, reloadKey]);

  useEffect(() => {
    if (preset) {
      setDraft(preset.text);
      input.current?.focus();
    }
  }, [preset]);

  const count = messages?.length ?? 0;
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [count]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    try {
      const { error: e } = await supabase.rpc("support_send", { p_workspace: workspaceId, p_text: text, p_as_platform: asPlatform });
      if (e) throw e;
      setDraft("");
      await load();
      onActivity?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    // На телефоне Enter переносит строку: отправка только кнопкой, как в мессенджерах.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !window.matchMedia("(max-width: 860px)").matches) {
      event.preventDefault();
      send();
    }
  }

  const mine = asPlatform ? "platform" : "owner";

  return (
    <div className="support-chat">
      <ol className="chat support-list" ref={list} aria-live="polite">
        {messages === null && !error && <li className="muted">Загружаем переписку…</li>}
        {messages?.length === 0 && <li className="support-empty muted">{emptyText}</li>}
        {messages?.map((m) => (
          <li key={m.id} className={`bubble ${m.sender === mine ? "bubble-agent" : "bubble-contact"}`}>
            {m.sender !== mine && <span className="bubble-who">{m.sender === "platform" ? "Поддержка Qabul" : m.author_email ?? "Владелец"}</span>}
            <p>{m.text}</p>
            <time dateTime={m.created_at} title={fullTime(m.created_at)}>
              {shortTime(m.created_at)}
            </time>
          </li>
        ))}
      </ol>
      <ErrorNote>{error}</ErrorNote>
      <form className="composer" onSubmit={send}>
        <textarea
          ref={input}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={asPlatform ? "Ответить владельцу" : "Напишите, чем мы можем помочь"}
          aria-label="Сообщение в поддержку"
          maxLength={4000}
        />
        <button className="button button-primary" disabled={sending || !draft.trim()} aria-label="Отправить">
          <Send size={18} aria-hidden />
        </button>
      </form>
    </div>
  );
}
