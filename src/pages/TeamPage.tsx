import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useApp } from "../App";
import { ErrorNote, Modal } from "../components/ui";
import { callFunction, errorText, supabase } from "../lib/supabase";
import type { Member } from "../lib/types";

export function TeamPage() {
  const { workspace, userId, reloadWorkspace } = useApp();
  const isOwner = workspace.role === "owner";
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [company, setCompany] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("workspace_members").select("user_id, email, role, created_at").eq("workspace_id", workspace.id).order("created_at");
    if (e) setError(e.message);
    else setMembers(data as Member[]);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await callFunction("team", { action: "add", workspace_id: workspace.id, email, password });
      setNotice(`Администратор ${email} добавлен. Передайте ему email и пароль для входа.`);
      setEmail("");
      setPassword("");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: Member) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await callFunction("team", { action: "remove", workspace_id: workspace.id, user_id: member.user_id });
      setRemoving(null);
      await load();
    } catch (e) {
      setRemoving(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    const { error: e } = await supabase.from("workspaces").update({ name: company.trim() }).eq("id", workspace.id);
    if (e) setError(e.message);
    else {
      setNotice("Название сохранено.");
      reloadWorkspace();
    }
  }

  return (
    <main className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Команда</h1>
          <p className="muted">Администраторы видят заявки и отвечают клиентам. Вопросы и каналы меняет только владелец.</p>
        </div>
      </header>

      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="note" role="status">{notice}</p>}

      <ul className="member-list">
        {members?.map((member) => (
          <li key={member.user_id}>
            <span>
              <strong>{member.email}</strong>
              {member.user_id === userId && <span className="muted"> (вы)</span>}
            </span>
            <span className="muted">{member.role === "owner" ? "Владелец" : "Администратор"}</span>
            {isOwner && member.role !== "owner" && (
              <button type="button" className="link-button link-danger" onClick={() => setRemoving(member)}>
                Удалить
              </button>
            )}
          </li>
        ))}
      </ul>

      {isOwner && (
        <>
          <h2 className="section-title">Добавить администратора</h2>
          <form className="form" onSubmit={add}>
            <label className="field">
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
            </label>
            <label className="field">
              Пароль для первого входа
              <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="off" required />
            </label>
            <button className="button button-primary" disabled={busy}>
              Добавить
            </button>
          </form>

          <h2 className="section-title">Кабинет</h2>
          <form className="form" onSubmit={rename}>
            <label className="field">
              Название компании
              <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} required />
            </label>
            <button className="button" disabled={company.trim() === workspace.name || !company.trim()}>
              Сохранить название
            </button>
          </form>
        </>
      )}

      {removing && (
        <Modal title="Удалить администратора?" onClose={() => setRemoving(null)}>
          <div className="stack">
            <p>{removing.email} больше не сможет войти. Его ответы клиентам останутся в истории заявок.</p>
            <div className="button-row">
              <button type="button" className="button button-danger" disabled={busy} onClick={() => remove(removing)}>
                Удалить
              </button>
              <button type="button" className="button" onClick={() => setRemoving(null)}>
                Оставить
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
