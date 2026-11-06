import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus, Search, Trash2 } from "lucide-react";
import { useApp } from "../App";
import { ChannelTag, Empty, ErrorNote, Modal } from "../components/ui";
import { fullTime, toLocalInput } from "../lib/format";
import { errorText, supabase } from "../lib/supabase";
import type { Lesson, LessonStudent, Platform } from "../lib/types";

interface Client {
  id: string;
  display_name: string | null;
  username: string | null;
  phone: string | null;
  channels: { platform: Platform } | null;
}

const clientName = (c: Client) => c.display_name || (c.username ? `@${c.username}` : "") || c.phone || "Без имени";

export function LessonsPage() {
  const { workspace } = useApp();
  const { lessonId } = useParams();
  const navigate = useNavigate();
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("lessons")
      .select("*, lesson_students(count)")
      .eq("workspace_id", workspace.id)
      .order("starts_at", { ascending: true, nullsFirst: false });
    if (e) {
      setError(`Не удалось загрузить уроки: ${e.message}`);
      return;
    }
    setError("");
    setLessons(data as Lesson[]);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const list = lessons ?? [];
    return [
      { title: "Ближайшие", items: list.filter((l) => l.starts_at && new Date(l.starts_at) >= today) },
      { title: "Без даты", items: list.filter((l) => !l.starts_at) },
      { title: "Прошедшие", items: list.filter((l) => l.starts_at && new Date(l.starts_at) < today).reverse() },
    ].filter((g) => g.items.length > 0);
  }, [lessons]);

  const isNew = lessonId === "new";
  const selected = lessons?.find((l) => l.id === lessonId) ?? null;

  return (
    <div className={`leads ${lessonId ? "has-detail" : ""}`}>
      <section className="lead-list" aria-label="Уроки">
        <header className="lead-list-head lessons-head">
          <div className="lead-list-title">
            <h1>Уроки</h1>
            <button type="button" className="button button-primary" onClick={() => navigate("/lessons/new")}>
              <Plus size={16} aria-hidden /> Новый урок
            </button>
          </div>
        </header>
        <ErrorNote>{error}</ErrorNote>
        {lessons === null && !error && <p className="muted pad">Загружаем уроки…</p>}
        <div className="rows">
          {lessons?.length === 0 && (
            <div className="pad">
              <Empty title="Уроков пока нет">
                <p>Создайте урок, укажите время и запишите на него клиентов из заявок или вручную.</p>
              </Empty>
            </div>
          )}
          {groups.map((group) => (
            <section key={group.title}>
              <h2 className="lessons-group">{group.title}</h2>
              <ul>
                {group.items.map((lesson) => (
                  <li key={lesson.id}>
                    <button
                      type="button"
                      className={`row ${lesson.id === lessonId ? "is-selected" : ""}`}
                      aria-current={lesson.id === lessonId ? "true" : undefined}
                      onClick={() => navigate(`/lessons/${lesson.id}`)}
                    >
                      <span className="row-main">
                        <span className="row-name">{lesson.title}</span>
                        <span className="row-preview">{lesson.starts_at ? fullTime(lesson.starts_at) : "Время не указано"}</span>
                      </span>
                      <span className="row-side">
                        <span>{lesson.lesson_students?.[0]?.count ?? 0} уч.</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </section>

      <section className="lead-detail" aria-label="Урок">
        {isNew ? (
          <LessonEditor key="new" lesson={null} onChanged={load} />
        ) : selected ? (
          <LessonEditor key={selected.id} lesson={selected} onChanged={load} />
        ) : (
          <div className="detail-empty">
            <p>{lessonId && lessons !== null ? "Урок не найден." : "Выберите урок или создайте новый."}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function LessonEditor({ lesson, onChanged }: { lesson: Lesson | null; onChanged: () => Promise<void> | void }) {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const [title, setTitle] = useState(lesson?.title ?? "");
  const [when, setWhen] = useState(toLocalInput(lesson?.starts_at ?? null));
  const [duration, setDuration] = useState(lesson?.duration_minutes ? String(lesson.duration_minutes) : "");
  const [notes, setNotes] = useState(lesson?.notes ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const touch = () => {
    setDirty(true);
    setSaved(false);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const fields = {
      title: title.trim(),
      starts_at: when ? new Date(when).toISOString() : null,
      duration_minutes: duration ? Number(duration) : null,
      notes: notes.trim() || null,
    };
    try {
      if (lesson) {
        const { error: e } = await supabase.from("lessons").update(fields).eq("id", lesson.id);
        if (e) throw e;
        setDirty(false);
        setSaved(true);
        await onChanged();
      } else {
        const { data, error: e } = await supabase.from("lessons").insert({ ...fields, workspace_id: workspace.id }).select().single();
        if (e) throw e;
        await onChanged();
        navigate(`/lessons/${data.id}`, { replace: true });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const { error: e } = await supabase.from("lessons").delete().eq("id", lesson!.id);
    if (e) {
      setError(e.message);
      setConfirmDelete(false);
      return;
    }
    await onChanged();
    navigate("/lessons", { replace: true });
  }

  return (
    <article className="lesson-editor">
      <header className="lesson-editor-head">
        <button type="button" className="icon-button back" onClick={() => navigate("/lessons")} aria-label="Назад к списку">
          <ArrowLeft size={20} aria-hidden />
        </button>
        <h2>{lesson ? lesson.title : "Новый урок"}</h2>
      </header>

      <form className="stack" onSubmit={save}>
        <label className="field">
          Название
          <input value={title} onChange={(e) => { setTitle(e.target.value); touch(); }} maxLength={200} placeholder="Например, Английский A1, группа 2" required />
        </label>
        <div className="lesson-when">
          <label className="field">
            Дата и время
            <input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); touch(); }} />
          </label>
          <label className="field">
            Длительность, мин
            <input type="number" min={1} max={1440} value={duration} onChange={(e) => { setDuration(e.target.value); touch(); }} />
          </label>
        </div>
        <label className="field lesson-notes">
          Заметки
          <textarea value={notes} onChange={(e) => { setNotes(e.target.value); touch(); }} maxLength={20000} placeholder="Преподаватель, кабинет, тема, что принести, любые детали" />
        </label>
        <ErrorNote>{error}</ErrorNote>
        <div className="save-bar-row">
          <button className="button button-primary" disabled={busy || (Boolean(lesson) && !dirty) || !title.trim()}>
            {lesson ? "Сохранить урок" : "Создать урок"}
          </button>
          {saved && !dirty && <span role="status">Урок сохранён</span>}
          {dirty && lesson && <span className="muted">Есть несохранённые изменения</span>}
          <span className="grow" />
          {lesson && (
            <button type="button" className="link-button link-danger" onClick={() => setConfirmDelete(true)}>
              Удалить урок
            </button>
          )}
        </div>
      </form>

      {lesson ? <Students lessonId={lesson.id} onChanged={onChanged} /> : <p className="muted">После создания урока сюда можно будет добавить учеников.</p>}

      {confirmDelete && (
        <Modal title={`Удалить урок «${lesson!.title}»?`} onClose={() => setConfirmDelete(false)}>
          <div className="stack">
            <p>Урок и список его учеников будут удалены. Заявки и клиенты останутся.</p>
            <div className="button-row">
              <button type="button" className="button button-danger" onClick={remove}>
                Удалить урок
              </button>
              <button type="button" className="button" onClick={() => setConfirmDelete(false)}>
                Оставить
              </button>
            </div>
          </div>
        </Modal>
      )}
    </article>
  );
}

function Students({ lessonId, onChanged }: { lessonId: string; onChanged: () => Promise<void> | void }) {
  const { workspace } = useApp();
  const [students, setStudents] = useState<LessonStudent[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("lesson_students").select("*").eq("lesson_id", lessonId).order("created_at");
    if (e) setError(e.message);
    else setStudents(data as LessonStudent[]);
  }, [lessonId]);

  useEffect(() => {
    load();
    supabase
      .from("contacts")
      .select("id, display_name, username, phone, channels(platform)")
      .eq("workspace_id", workspace.id)
      .order("last_seen_at", { ascending: false })
      .limit(1000)
      .then(({ data }) => setClients((data ?? []) as unknown as Client[]));
  }, [load, workspace.id]);

  const joined = useMemo(() => new Set(students?.map((s) => s.contact_id)), [students]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return clients
      .filter((c) => !joined.has(c.id) && [c.display_name, c.username, c.phone].some((v) => v?.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [clients, joined, query]);

  async function insert(row: { contact_id?: string; name: string; phone: string | null }) {
    setError("");
    const { error: e } = await supabase.from("lesson_students").insert({ ...row, workspace_id: workspace.id, lesson_id: lessonId });
    if (e) {
      setError(e.code === "23505" ? "Этот клиент уже записан на урок." : e.message);
      return false;
    }
    await Promise.all([load(), onChanged()]);
    return true;
  }

  async function addClient(client: Client) {
    if (await insert({ contact_id: client.id, name: clientName(client), phone: client.phone })) setQuery("");
  }

  async function addManual(event: FormEvent) {
    event.preventDefault();
    if (await insert({ name: name.trim(), phone: phone.trim() || null })) {
      setName("");
      setPhone("");
    }
  }

  async function remove(student: LessonStudent) {
    const { error: e } = await supabase.from("lesson_students").delete().eq("id", student.id);
    if (e) setError(e.message);
    await Promise.all([load(), onChanged()]);
  }

  async function saveNote(student: LessonStudent, note: string) {
    if (note === (student.note ?? "")) return;
    const { error: e } = await supabase.from("lesson_students").update({ note: note || null }).eq("id", student.id);
    if (e) setError(e.message);
    else load();
  }

  return (
    <section className="stack" aria-label="Ученики">
      <h3>Ученики{students && students.length > 0 ? ` (${students.length})` : ""}</h3>
      <ErrorNote>{error}</ErrorNote>

      {students && students.length > 0 && (
        <ul className="student-list">
          {students.map((student) => (
            <li className="student" key={student.id}>
              <span className="student-who">
                <strong>{student.name}</strong>
                {student.phone && <a href={`tel:${student.phone}`}>{student.phone}</a>}
              </span>
              <input
                className="student-note"
                defaultValue={student.note ?? ""}
                placeholder="Заметка"
                aria-label={`Заметка: ${student.name}`}
                maxLength={2000}
                onBlur={(e) => saveNote(student, e.target.value.trim())}
              />
              <button type="button" className="icon-button" onClick={() => remove(student)} aria-label={`Убрать: ${student.name}`}>
                <Trash2 size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="student-add">
        <div className="client-search">
          <label className="search">
            <Search size={16} aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Найти клиента из заявок по имени или телефону"
              aria-label="Найти клиента"
            />
          </label>
          {query.trim() && (
            <div className="client-results">
              {results.length === 0 && <p className="muted pad">Клиент не найден. Добавьте его вручную ниже.</p>}
              {results.map((client) => (
                <button type="button" className="client-result" key={client.id} onClick={() => addClient(client)}>
                  {client.channels && <ChannelTag platform={client.channels.platform} />}
                  <span className="row-main">
                    <span className="row-name">{clientName(client)}</span>
                    {client.phone && <span className="row-preview">{client.phone}</span>}
                  </span>
                  <Plus size={16} aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>

        <form className="manual-student" onSubmit={addManual}>
          <label className="field">
            Имя ученика
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
          </label>
          <label className="field">
            Телефон
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
          </label>
          <button className="button" disabled={!name.trim()}>
            Добавить вручную
          </button>
        </form>
      </div>
    </section>
  );
}
