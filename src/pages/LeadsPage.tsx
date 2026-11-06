import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, Search, Send } from "lucide-react";
import { useApp } from "../App";
import { QuickReplies } from "../components/QuickReplies";
import { ChannelTag, Empty, ErrorNote } from "../components/ui";
import { contactName, csvCell, fullTime, money, shortTime, STATUS_LABEL } from "../lib/format";
import { PLATFORMS } from "../lib/platforms";
import { callFunction, errorText, supabase } from "../lib/supabase";
import type { Answer, Lead, LeadStatus, Lesson, LessonStudent, Member, Message, Question } from "../lib/types";

const LEAD_COLUMNS = "*, contacts(display_name, username, phone, external_id), channels(platform, name)";
const POLL_MS = 15_000;

type Tab = "new" | "in_work" | "collecting" | "closed";

const TABS: { id: Tab; label: string; statuses: LeadStatus[] }[] = [
  { id: "new", label: "Новые", statuses: ["new"] },
  { id: "in_work", label: "В работе", statuses: ["in_work"] },
  { id: "collecting", label: "В опросе", statuses: ["collecting"] },
  { id: "closed", label: "Закрытые", statuses: ["done", "rejected"] },
];

const tabOf = (status: LeadStatus): Tab => TABS.find((t) => t.statuses.includes(status))!.id;

export function LeadsPage() {
  const { workspace } = useApp();
  const { leadId } = useParams();
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [tab, setTab] = useState<Tab>("new");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [hasChannels, setHasChannels] = useState(true);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("leads")
      .select(LEAD_COLUMNS)
      .eq("workspace_id", workspace.id)
      .order("last_message_at", { ascending: false })
      .limit(500);
    if (e) {
      setError(`Не удалось загрузить заявки: ${e.message}`);
      return;
    }
    setError("");
    setLeads(data as unknown as Lead[]);
  }, [workspace.id]);

  useEffect(() => {
    load();
    supabase
      .from("channels")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .is("deleted_at", null)
      .then(({ count }) => setHasChannels(Boolean(count)));

    // Realtime доставляет изменения сразу, опрос раз в 15 секунд страхует от обрыва соединения.
    const live = supabase
      .channel(`leads-${workspace.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "leads", filter: `workspace_id=eq.${workspace.id}` }, () => load())
      .subscribe();
    const timer = setInterval(load, POLL_MS);
    return () => {
      supabase.removeChannel(live);
      clearInterval(timer);
    };
  }, [load, workspace.id]);

  const counts = useMemo(() => {
    const result: Record<Tab, number> = { new: 0, in_work: 0, collecting: 0, closed: 0 };
    for (const lead of leads ?? []) result[tabOf(lead.status)]++;
    return result;
  }, [leads]);

  useEffect(() => {
    document.title = counts.new > 0 ? `(${counts.new}) Qabul` : "Qabul";
    return () => {
      document.title = "Qabul";
    };
  }, [counts.new]);

  const selected = leads?.find((l) => l.id === leadId) ?? null;

  // Вкладка следует за заявкой, открытой по прямой ссылке.
  const followed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (selected && followed.current !== selected.id) {
      followed.current = selected.id;
      setTab(tabOf(selected.status));
    }
  }, [selected]);

  const visible = useMemo(() => {
    const statuses = TABS.find((t) => t.id === tab)!.statuses;
    const q = query.trim().toLowerCase();
    return (leads ?? []).filter((lead) => {
      if (!q && !statuses.includes(lead.status)) return false;
      if (!q) return true;
      return [lead.contacts?.display_name, lead.contacts?.username, lead.contacts?.phone, lead.last_message_preview]
        .some((v) => v?.toLowerCase().includes(q));
    });
  }, [leads, tab, query]);

  async function exportCsv() {
    const ids = visible.map((l) => l.id);
    const { data, error: e } = await supabase.from("answers").select("lead_id, question_text, answer_text, position").in("lead_id", ids).order("position");
    if (e) {
      setError(`Не удалось выгрузить ответы: ${e.message}`);
      return;
    }
    const questions = [...new Set((data ?? []).map((a) => a.question_text))];
    const head = ["Дата", "Статус", "Канал", "Клиент", "Телефон", ...questions];
    const rows = visible.map((lead) => {
      const own = (data ?? []).filter((a) => a.lead_id === lead.id);
      return [
        fullTime(lead.created_at),
        STATUS_LABEL[lead.status],
        lead.channels ? PLATFORMS[lead.channels.platform].label : "",
        contactName(lead),
        lead.contacts?.phone,
        ...questions.map((q) => own.find((a) => a.question_text === q)?.answer_text),
      ];
    });
    const csv = [head, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `zayavki-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={`leads ${leadId ? "has-detail" : ""}`}>
      <section className="lead-list" aria-label="Заявки">
        <header className="lead-list-head">
          <div className="lead-list-title">
            <h1>Заявки</h1>
            <button type="button" className="icon-button" onClick={exportCsv} disabled={visible.length === 0} title="Скачать CSV" aria-label="Скачать CSV">
              <Download size={18} aria-hidden />
            </button>
          </div>
          <label className="search">
            <Search size={16} aria-hidden />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Имя, телефон или текст" aria-label="Поиск по заявкам" />
          </label>
          {!query && (
            <div className="tabs" role="tablist" aria-label="Статус заявки">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
                  {t.label}
                  {counts[t.id] > 0 && <span className="count">{counts[t.id]}</span>}
                </button>
              ))}
            </div>
          )}
        </header>

        <ErrorNote>{error}</ErrorNote>
        {leads === null && !error && <p className="muted pad">Загружаем заявки…</p>}

        {leads !== null && visible.length === 0 && (
          <div className="pad">
            {query ? (
              <p className="muted">Ничего не найдено.</p>
            ) : !hasChannels && workspace.role === "owner" && leads.length === 0 ? (
              <Empty title="Заявок пока нет">
                <p>Подключите соцсеть в разделе «Каналы» и напишите своему боту. Первая заявка появится здесь.</p>
                <button type="button" className="button" onClick={() => navigate("/channels")}>
                  Подключить канал
                </button>
              </Empty>
            ) : (
              <p className="muted">В этом разделе пока пусто.</p>
            )}
          </div>
        )}

        <ul className="rows">
          {visible.map((lead) => (
            <li key={lead.id}>
              <button
                type="button"
                className={`row ${lead.id === leadId ? "is-selected" : ""}`}
                aria-current={lead.id === leadId ? "true" : undefined}
                onClick={() => navigate(`/leads/${lead.id}`)}
              >
                {lead.channels && <ChannelTag platform={lead.channels.platform} />}
                <span className="row-main">
                  <span className="row-name">{contactName(lead)}</span>
                  <span className="row-preview">{lead.last_message_preview || "Нет сообщений"}</span>
                </span>
                <span className="row-side">
                  <time dateTime={lead.last_message_at}>{shortTime(lead.last_message_at)}</time>
                  {lead.unread_count > 0 && lead.status !== "collecting" && (
                    <span className="count count-strong" aria-label={`Непрочитанных: ${lead.unread_count}`}>
                      {lead.unread_count}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="lead-detail" aria-label="Заявка">
        {selected ? (
          <LeadDetail key={selected.id} lead={selected} onChanged={load} onBack={() => navigate("/leads")} />
        ) : (
          <div className="detail-empty">
            <p>{leadId && leads !== null ? "Заявка не найдена." : "Выберите заявку, чтобы увидеть ответы и переписку."}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function LeadLessons({ lead }: { lead: Lead }) {
  const { workspace } = useApp();
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [joined, setJoined] = useState<LessonStudent[]>([]);
  const [lessonId, setLessonId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [l, s] = await Promise.all([
      supabase.from("lessons").select("*").eq("workspace_id", workspace.id).order("starts_at", { ascending: true, nullsFirst: false }),
      supabase.from("lesson_students").select("*").eq("contact_id", lead.contact_id),
    ]);
    if (l.error || s.error) {
      setError((l.error ?? s.error)!.message);
      return;
    }
    setLessons(l.data as Lesson[]);
    setJoined(s.data as LessonStudent[]);
  }, [workspace.id, lead.contact_id]);

  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    if (!lessonId) return;
    setError("");
    const { error: e } = await supabase.from("lesson_students").insert({
      workspace_id: workspace.id,
      lesson_id: lessonId,
      contact_id: lead.contact_id,
      name: contactName(lead),
      phone: lead.contacts?.phone ?? null,
    });
    if (e) setError(e.code === "23505" ? "Клиент уже записан на этот урок." : e.message);
    setLessonId("");
    load();
  }

  const joinedIds = new Set(joined.map((s) => s.lesson_id));
  const debtOf = (id: string) => joined.find((s) => s.lesson_id === id)?.debt ?? 0;
  const available = lessons.filter((l) => !joinedIds.has(l.id) && (!l.starts_at || new Date(l.starts_at).getTime() > Date.now() - 86_400_000));

  return (
    <section className="lead-lessons" aria-label="Уроки клиента">
      <h3>Уроки</h3>
      <ErrorNote>{error}</ErrorNote>
      {lessons.filter((l) => joinedIds.has(l.id)).map((l) => (
        <Link key={l.id} to={`/lessons/${l.id}`} className="lesson-link">
          {l.title}
          {l.starts_at && <span className="muted">, {fullTime(l.starts_at)}</span>}
          {debtOf(l.id) > 0 && <span className="debt">, долг {money(debtOf(l.id))}</span>}
        </Link>
      ))}
      {lessons.length === 0 ? (
        <p className="muted">Уроков пока нет. <Link to="/lessons/new">Создать урок</Link></p>
      ) : (
        <div className="lesson-add">
          <select value={lessonId} onChange={(e) => setLessonId(e.target.value)} aria-label="Выберите урок">
            <option value="">Записать на урок…</option>
            {available.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}{l.starts_at ? `, ${fullTime(l.starts_at)}` : ""}
              </option>
            ))}
          </select>
          <button type="button" className="button" onClick={add} disabled={!lessonId}>
            Записать
          </button>
        </div>
      )}
    </section>
  );
}

function LeadDetail({ lead, onChanged, onBack }: { lead: Lead; onChanged: () => Promise<void> | void; onBack: () => void }) {
  const { userId, workspace } = useApp();
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [current, setCurrent] = useState<Question | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(lead.note ?? "");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const chatList = useRef<HTMLOListElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const [panel, setPanel] = useState<"sheet" | "chat">("sheet");

  const loadDetail = useCallback(async () => {
    const [a, m] = await Promise.all([
      supabase.from("answers").select("*").eq("lead_id", lead.id).order("position"),
      supabase.from("messages").select("*").eq("lead_id", lead.id).order("created_at"),
    ]);
    if (a.error || m.error) {
      setError(`Не удалось загрузить заявку: ${(a.error ?? m.error)!.message}`);
      return;
    }
    setAnswers(a.data as Answer[]);
    setMessages(m.data as Message[]);
    return m.data as Message[];
  }, [lead.id]);

  useEffect(() => {
    loadDetail();
    const live = supabase
      .channel(`lead-${lead.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `lead_id=eq.${lead.id}` }, () => loadDetail())
      .on("postgres_changes", { event: "*", schema: "public", table: "answers", filter: `lead_id=eq.${lead.id}` }, () => loadDetail())
      .subscribe();
    const timer = setInterval(loadDetail, POLL_MS);
    return () => {
      supabase.removeChannel(live);
      clearInterval(timer);
    };
  }, [lead.id, loadDetail]);

  // Обновление счётчика и подгрузка переписки зависят только от изменений заявки, а не от ввода в полях.
  useEffect(() => {
    if (lead.unread_count > 0) {
      supabase.rpc("mark_lead_read", { p_lead_id: lead.id }).then(() => onChanged());
    }
    loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id, lead.unread_count, lead.last_message_at, lead.status]);

  useEffect(() => {
    if (!lead.current_question_id) {
      setCurrent(null);
      return;
    }
    supabase.from("questions").select("*").eq("id", lead.current_question_id).maybeSingle().then(({ data }) => setCurrent(data as Question | null));
  }, [lead.current_question_id]);

  useEffect(() => {
    supabase.from("workspace_members").select("user_id, email, role, created_at").eq("workspace_id", workspace.id).then(({ data }) => setMembers((data ?? []) as Member[]));
  }, [workspace.id]);

  const messageCount = messages?.length ?? 0;
  useEffect(() => {
    // Прокручиваем только саму переписку: на телефоне страница остаётся на анкете.
    const list = chatList.current;
    if (list) list.scrollTop = list.scrollHeight;
    if (panel === "chat" && window.matchMedia("(max-width: 860px)").matches) {
      // Форма ответа прилипает к низу, поэтому прокручиваем сам раздел заявки к последнему сообщению.
      composer.current?.closest(".lead-detail")?.scrollTo(0, 1_000_000);
    }
  }, [messageCount, panel]);

  async function run(action: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError("");
    const { error: e } = await action();
    if (e) setError(e.message);
    await onChanged();
    setBusy(false);
  }

  const take = () => run(() => supabase.rpc("take_lead", { p_lead_id: lead.id }));
  const setStatus = (status: LeadStatus) => run(() => supabase.rpc("set_lead_status", { p_lead_id: lead.id, p_status: status }));

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    let failure = "";
    try {
      await callFunction("send-message", { lead_id: lead.id, text });
      setDraft("");
    } catch (e) {
      failure = errorText(e);
    }
    const [fresh] = await Promise.all([loadDetail(), onChanged()]);
    // Если сообщение сохранилось как недоставленное, причина уже показана прямо под ним.
    if (failure && !fresh?.some((m) => m.status === "failed" && m.error === failure)) setError(failure);
    setSending(false);
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  async function saveNote() {
    if (note === (lead.note ?? "")) return;
    const { error: e } = await supabase.rpc("set_lead_note", { p_lead_id: lead.id, p_note: note });
    if (e) setError(e.message);
    else onChanged();
  }

  const assignee = members.find((m) => m.user_id === lead.assigned_to);
  const platform = lead.channels?.platform;
  const profile = lead.contacts?.username ? `@${lead.contacts.username}` : null;

  return (
    <article className="detail">
      <header className="detail-head">
        <button type="button" className="icon-button back" onClick={onBack} aria-label="Назад к списку">
          <ArrowLeft size={20} aria-hidden />
        </button>
        <div className="detail-who">
          <h2>{contactName(lead)}</h2>
          <p>
            {platform && <ChannelTag platform={platform} />}
            <span>{lead.channels?.name}</span>
            {profile && <span>{profile}</span>}
            {lead.contacts?.phone && <a href={`tel:${lead.contacts.phone}`}>{lead.contacts.phone}</a>}
          </p>
        </div>
        <div className="detail-actions">
          <span className={`status status-${lead.status}`}>
            {STATUS_LABEL[lead.status]}
            {lead.status === "in_work" && assignee?.email ? `: ${assignee.user_id === userId ? "вы" : assignee.email}` : ""}
          </span>
          {(lead.status === "new" || lead.status === "collecting") && (
            <button type="button" className="button button-primary" onClick={take} disabled={busy}>
              Взять в работу
            </button>
          )}
          {lead.status === "in_work" && (
            <>
              {lead.assigned_to !== userId && (
                <button type="button" className="button" onClick={take} disabled={busy}>
                  Взять себе
                </button>
              )}
              <button type="button" className="button button-primary" onClick={() => setStatus("done")} disabled={busy}>
                Завершить
              </button>
              <button type="button" className="button" onClick={() => setStatus("rejected")} disabled={busy}>
                Отказ
              </button>
              <button type="button" className="link-button" onClick={() => setStatus("new")} disabled={busy}>
                Вернуть в новые
              </button>
            </>
          )}
          {(lead.status === "done" || lead.status === "rejected") && (
            <button type="button" className="button" onClick={() => setStatus("in_work")} disabled={busy}>
              Вернуть в работу
            </button>
          )}
        </div>
      </header>

      <ErrorNote>{error}</ErrorNote>
      {lead.handoff && lead.status === "new" && <p className="note note-attention">Клиент не смог пройти опрос или попросил живого человека. Ответьте ему лично.</p>}

      <div className="detail-switch" role="tablist" aria-label="Раздел заявки">
        <button type="button" role="tab" aria-selected={panel === "sheet"} onClick={() => setPanel("sheet")}>
          Анкета
        </button>
        <button type="button" role="tab" aria-selected={panel === "chat"} onClick={() => setPanel("chat")}>
          Переписка{messageCount > 0 ? ` (${messageCount})` : ""}
        </button>
      </div>

      <div className={`detail-columns show-${panel}`}>
        <div className="detail-sheet">
          <h3>Анкета</h3>
          <dl className="sheet">
            {answers.map((answer) => (
              <div className="sheet-row" key={answer.id}>
                <dt>{answer.question_text}</dt>
                <dd>{answer.answer_text ? <mark>{answer.answer_text}</mark> : <span className="muted">Пропущено</span>}</dd>
              </div>
            ))}
            {lead.status === "collecting" && current && (
              <div className="sheet-row">
                <dt>{current.text}</dt>
                <dd className="muted">Ждём ответ клиента</dd>
              </div>
            )}
            {answers.length === 0 && !(lead.status === "collecting" && current) && (
              <div className="sheet-row">
                <dd className="muted">Клиент не ответил ни на один вопрос.</dd>
              </div>
            )}
          </dl>
          <label className="field note-field">
            Заметка для команды
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} maxLength={4000} placeholder="Клиента не видит, только администраторы" />
          </label>
          <LeadLessons lead={lead} />
        </div>

        <div className="detail-chat">
          <h3>Переписка</h3>
          <ol className="chat" aria-live="polite" ref={chatList}>
            {messages === null && <li className="muted">Загружаем…</li>}
            {messages?.map((m) => (
              <li key={m.id} className={`bubble bubble-${m.sender}`}>
                {m.sender !== "contact" && <span className="bubble-who">{m.sender === "bot" ? "Бот" : "Администратор"}</span>}
                <p>{m.text ?? (m.attachment ? <em>{m.attachment}</em> : <em>Сообщение без текста</em>)}</p>
                {m.options?.length > 0 && (
                  <ul className="bubble-options">
                    {m.options.map((o) => (
                      <li key={o.id}>{o.label}</li>
                    ))}
                  </ul>
                )}
                <time dateTime={m.created_at} title={fullTime(m.created_at)}>
                  {shortTime(m.created_at)}
                </time>
                {m.status === "failed" && <span className="bubble-error" role="alert">Не доставлено. {m.error}</span>}
                {m.status === "queued" && <span className="muted">Отправляется…</span>}
              </li>
            ))}
          </ol>
          <QuickReplies
            onPick={(text) => {
              setDraft((current) => (current.trim() ? `${current.trimEnd()}\n${text}` : text));
              draftInput.current?.focus();
            }}
          />
          <form className="composer" onSubmit={send} ref={composer}>
            <textarea
              ref={draftInput}
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder={lead.status === "collecting" ? "Ответ остановит бота и закрепит заявку за вами" : "Ответить клиенту"}
              aria-label="Ответ клиенту"
              maxLength={4000}
            />
            <button className="button button-primary" disabled={sending || !draft.trim()} aria-label="Отправить">
              <Send size={18} aria-hidden />
            </button>
          </form>
        </div>
      </div>
    </article>
  );
}
