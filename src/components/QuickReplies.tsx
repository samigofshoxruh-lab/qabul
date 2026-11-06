import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, Settings2 } from "lucide-react";
import { useApp } from "../App";
import { errorText, supabase } from "../lib/supabase";
import type { QuickReply } from "../lib/types";
import { ErrorNote, Modal } from "./ui";

function ReplyEditor({ reply, onSaved, onDeleted }: { reply: QuickReply; onSaved: () => void; onDeleted: () => void }) {
  const [title, setTitle] = useState(reply.title);
  const [text, setText] = useState(reply.text);
  const [error, setError] = useState("");
  const dirty = title !== reply.title || text !== reply.text;

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    const { error: e } = await supabase.from("quick_replies").update({ title: title.trim(), text: text.trim() }).eq("id", reply.id);
    if (e) setError(errorText(e));
    else onSaved();
  }

  async function remove() {
    const { error: e } = await supabase.from("quick_replies").delete().eq("id", reply.id);
    if (e) setError(errorText(e));
    else onDeleted();
  }

  return (
    <form className="reply-item" onSubmit={save}>
      <label className="field">
        Кнопка
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} required />
      </label>
      <label className="field">
        Текст
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} required />
      </label>
      <ErrorNote>{error}</ErrorNote>
      <div className="reply-actions">
        <button className="button" disabled={!dirty || !title.trim() || !text.trim()}>
          Сохранить
        </button>
        <button type="button" className="link-button link-danger" onClick={remove}>
          Удалить
        </button>
      </div>
    </form>
  );
}

/** Кнопки над полем ответа. Текст попадает в поле: перед отправкой его можно поправить. */
export function QuickReplies({ onPick }: { onPick: (text: string) => void }) {
  const { workspace } = useApp();
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("quick_replies").select("*").eq("workspace_id", workspace.id).order("created_at");
    if (e) setError(errorText(e));
    else setReplies(data as QuickReply[]);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setError("");
    const { error: e } = await supabase.from("quick_replies").insert({ workspace_id: workspace.id, title: title.trim(), text: text.trim() });
    if (e) {
      setError(errorText(e));
      return;
    }
    setTitle("");
    setText("");
    await load();
  }

  return (
    <div className="reply-bar" role="group" aria-label="Быстрые ответы">
      {replies.map((reply) => (
        <button type="button" className="chip" key={reply.id} onClick={() => onPick(reply.text)} title={reply.text}>
          {reply.title}
        </button>
      ))}
      {replies.length === 0 ? (
        <button type="button" className="chip" onClick={() => setEditing(true)}>
          <Plus size={14} aria-hidden /> Быстрый ответ
        </button>
      ) : (
        <button type="button" className="icon-button" onClick={() => setEditing(true)} aria-label="Настроить быстрые ответы">
          <Settings2 size={18} aria-hidden />
        </button>
      )}

      {editing && (
        <Modal title="Быстрые ответы" onClose={() => setEditing(false)}>
          <div className="reply-list">
            <p className="muted">Кнопка вставляет готовый текст в поле ответа. Например, цены, адрес или расписание. Ответы общие для всей команды.</p>
            {replies.map((reply) => (
              <ReplyEditor key={`${reply.id}:${reply.title}:${reply.text}`} reply={reply} onSaved={load} onDeleted={load} />
            ))}
            <form className="reply-item" onSubmit={add}>
              <label className="field">
                Кнопка
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} placeholder="Например, Цены" required />
              </label>
              <label className="field">
                Текст
                <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} placeholder="Текст, который получит клиент" required />
              </label>
              <ErrorNote>{error}</ErrorNote>
              <div className="reply-actions">
                <button className="button button-primary" disabled={!title.trim() || !text.trim()}>
                  Добавить ответ
                </button>
              </div>
            </form>
          </div>
        </Modal>
      )}
    </div>
  );
}
