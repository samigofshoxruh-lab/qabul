import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useApp } from "../App";
import { ErrorNote, Modal } from "../components/ui";
import { errorText, supabase } from "../lib/supabase";
import type { Option, Question, QuestionType, Survey } from "../lib/types";

const randomId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

type Draft = Omit<Question, "survey_id" | "position">;

const newOption = (label = ""): Option => ({ id: randomId(), label });

function newQuestion(type: QuestionType, text = "", patch: Partial<Draft> = {}): Draft {
  return {
    id: crypto.randomUUID(),
    type,
    text,
    options: type === "choice" ? [newOption(), newOption()] : [],
    allow_other: false,
    required: true,
    ...patch,
  };
}

const COURSE_TEMPLATE = (): Draft[] => [
  newQuestion("choice", "Какой курс вас интересует?", {
    options: [newOption("Английский язык"), newOption("Программирование"), newOption("Подготовка к IELTS")],
    allow_other: true,
  }),
  newQuestion("choice", "Когда вам удобно прийти на первое занятие?", {
    options: [newOption("Суббота, 10:00"), newOption("Воскресенье, 12:00")],
    allow_other: true,
  }),
  newQuestion("text", "Как вас зовут?"),
  newQuestion("phone", "Оставьте номер телефона, чтобы мы подтвердили запись"),
  newQuestion("text", "Есть ли пожелания к занятиям?", { required: false }),
];

const TYPE_LABEL: Record<QuestionType, string> = {
  choice: "Выбор варианта",
  text: "Свободный ответ",
  phone: "Телефон",
};

function validate(questions: Draft[]): string {
  for (const [index, q] of questions.entries()) {
    const n = index + 1;
    if (!q.text.trim()) return `Вопрос ${n}: напишите текст вопроса.`;
    if (q.type === "choice") {
      const labels = q.options.map((o) => o.label.trim());
      if (labels.some((l) => !l)) return `Вопрос ${n}: заполните все варианты или удалите пустые.`;
      if (labels.length < 2) return `Вопрос ${n}: нужно минимум два варианта.`;
      if (labels.length > 10) return `Вопрос ${n}: не больше десяти вариантов.`;
      if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) return `Вопрос ${n}: варианты не должны повторяться.`;
    }
  }
  return "";
}

export function SurveysPage() {
  const { workspace } = useApp();
  const [surveys, setSurveys] = useState<Survey[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("surveys").select("*").eq("workspace_id", workspace.id).order("created_at");
    if (e) {
      setError(e.message);
      return;
    }
    setSurveys(data as Survey[]);
    setSelectedId((current) => current ?? (data as Survey[]).find((s) => s.is_default)?.id ?? data?.[0]?.id ?? null);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function createSurvey() {
    setError("");
    const { data, error: e } = await supabase
      .from("surveys")
      .insert({
        workspace_id: workspace.id,
        name: `Опрос ${(surveys?.length ?? 0) + 1}`,
        welcome_text: "Здравствуйте! Задам несколько коротких вопросов.",
        completion_text: "Спасибо! Администратор скоро свяжется с вами.",
      })
      .select()
      .single();
    if (e) {
      setError(e.message);
      return;
    }
    await load();
    setSelectedId(data.id);
  }

  const selected = surveys?.find((s) => s.id === selectedId) ?? null;

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>Вопросы</h1>
          <p className="muted">Бот задаёт их по порядку каждому, кто напишет в подключённый канал.</p>
        </div>
      </header>

      <ErrorNote>{error}</ErrorNote>

      {surveys && (
        <div className="tabs tabs-page">
          <div role="tablist" aria-label="Опросы" className="tabs-inner">
            {surveys.map((s) => (
              <button key={s.id} type="button" role="tab" aria-selected={s.id === selectedId} className="tab" onClick={() => setSelectedId(s.id)}>
                {s.name}
                {s.is_default && !s.name.toLowerCase().includes("основной") && <span className="muted"> (основной)</span>}
              </button>
            ))}
          </div>
          <button type="button" className="tab" onClick={createSurvey}>
            <Plus size={14} aria-hidden /> Новый опрос
          </button>
        </div>
      )}

      {selected && <SurveyEditor key={selected.id} survey={selected} onChanged={load} onDeleted={() => { setSelectedId(null); load(); }} />}
    </main>
  );
}

function SurveyEditor({ survey, onChanged, onDeleted }: { survey: Survey; onChanged: () => Promise<void> | void; onDeleted: () => void }) {
  const [name, setName] = useState(survey.name);
  const [welcome, setWelcome] = useState(survey.welcome_text ?? "");
  const [completion, setCompletion] = useState(survey.completion_text ?? "");
  const [questions, setQuestions] = useState<Draft[] | null>(null);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    supabase
      .from("questions")
      .select("*")
      .eq("survey_id", survey.id)
      .order("position")
      .order("created_at")
      .then(({ data, error: e }) => {
        if (e) {
          setError(e.message);
          return;
        }
        setQuestions(data as Question[]);
        setSavedIds((data ?? []).map((q) => q.id));
      });
  }, [survey.id]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const touch = () => {
    setDirty(true);
    setSaved(false);
  };

  function update(id: string, patch: Partial<Draft>) {
    setQuestions((list) => list!.map((q) => (q.id === id ? { ...q, ...patch } : q)));
    touch();
  }

  function setList(next: Draft[]) {
    setQuestions(next);
    touch();
  }

  function move(index: number, delta: number) {
    const next = [...questions!];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setList(next);
  }

  async function save() {
    const list = questions ?? [];
    const problem = !name.trim() ? "Напишите название опроса." : validate(list);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error: surveyError } = await supabase
        .from("surveys")
        .update({ name: name.trim(), welcome_text: welcome.trim() || null, completion_text: completion.trim() || null })
        .eq("id", survey.id);
      if (surveyError) throw surveyError;

      if (list.length > 0) {
        const { error: upsertError } = await supabase.from("questions").upsert(
          list.map((q, index) => ({
            id: q.id,
            survey_id: survey.id,
            position: index + 1,
            type: q.type,
            text: q.text.trim(),
            options: q.type === "choice" ? q.options.map((o) => ({ id: o.id, label: o.label.trim() })) : [],
            allow_other: q.type === "choice" && q.allow_other,
            required: q.required,
          })),
        );
        if (upsertError) throw upsertError;
      }

      const keep = new Set(list.map((q) => q.id));
      const removed = savedIds.filter((id) => !keep.has(id));
      if (removed.length > 0) {
        const { error: deleteError } = await supabase.from("questions").delete().in("id", removed);
        if (deleteError) throw deleteError;
      }

      setSavedIds(list.map((q) => q.id));
      setDirty(false);
      setSaved(true);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault() {
    const { error: e } = await supabase.rpc("set_default_survey", { p_survey_id: survey.id });
    if (e) setError(e.message);
    else onChanged();
  }

  async function remove() {
    setConfirmDelete(false);
    const { error: e } = await supabase.from("surveys").delete().eq("id", survey.id);
    if (e) setError(e.message);
    else onDeleted();
  }

  const preview = useMemo(() => {
    const list = questions ?? [];
    return list.filter((q) => q.text.trim());
  }, [questions]);

  if (questions === null) return <p className="muted">Загружаем вопросы…</p>;

  return (
    <div className="editor">
      <div className="editor-main">
        <div className="form form-wide">
          <label className="field">
            Название
            <input value={name} onChange={(e) => { setName(e.target.value); touch(); }} maxLength={120} />
          </label>
          <label className="field">
            Приветствие
            <textarea rows={2} value={welcome} onChange={(e) => { setWelcome(e.target.value); touch(); }} maxLength={900} placeholder="Первое сообщение бота. Можно оставить пустым." />
          </label>
        </div>

        <ol className="question-list">
          {questions.map((q, index) => (
            <li key={q.id} className="question">
              <div className="question-head">
                <span className="question-number">{index + 1}</span>
                <label className="field grow">
                  <span className="sr-only">Текст вопроса {index + 1}</span>
                  <textarea rows={2} value={q.text} onChange={(e) => update(q.id, { text: e.target.value })} maxLength={900} placeholder="Текст вопроса" />
                </label>
                <div className="question-tools">
                  <button type="button" className="icon-button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Поднять вопрос ${index + 1}`}>
                    <ArrowUp size={18} aria-hidden />
                  </button>
                  <button type="button" className="icon-button" onClick={() => move(index, 1)} disabled={index === questions.length - 1} aria-label={`Опустить вопрос ${index + 1}`}>
                    <ArrowDown size={18} aria-hidden />
                  </button>
                  <button type="button" className="icon-button" onClick={() => setList(questions.filter((x) => x.id !== q.id))} aria-label={`Удалить вопрос ${index + 1}`}>
                    <Trash2 size={18} aria-hidden />
                  </button>
                </div>
              </div>

              <div className="question-settings">
                <label className="field field-inline">
                  Тип ответа
                  <select
                    value={q.type}
                    onChange={(e) => {
                      const type = e.target.value as QuestionType;
                      update(q.id, { type, options: type === "choice" && q.options.length < 2 ? [newOption(), newOption()] : q.options });
                    }}
                  >
                    {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" checked={!q.required} onChange={(e) => update(q.id, { required: !e.target.checked })} />
                  Можно пропустить
                </label>
                {q.type === "choice" && (
                  <label className="check">
                    <input type="checkbox" checked={q.allow_other} onChange={(e) => update(q.id, { allow_other: e.target.checked })} />
                    Клиент может написать свой вариант
                  </label>
                )}
              </div>

              {q.type === "choice" && (
                <ul className="option-list">
                  {q.options.map((option, i) => (
                    <li key={option.id}>
                      <input
                        value={option.label}
                        aria-label={`Вариант ${i + 1}`}
                        placeholder={`Вариант ${i + 1}`}
                        maxLength={100}
                        onChange={(e) => update(q.id, { options: q.options.map((o) => (o.id === option.id ? { ...o, label: e.target.value } : o)) })}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        disabled={q.options.length <= 2}
                        aria-label={`Удалить вариант ${i + 1}`}
                        onClick={() => update(q.id, { options: q.options.filter((o) => o.id !== option.id) })}
                      >
                        <Trash2 size={16} aria-hidden />
                      </button>
                    </li>
                  ))}
                  {q.options.length < 10 && (
                    <li>
                      <button type="button" className="link-button" onClick={() => update(q.id, { options: [...q.options, newOption()] })}>
                        <Plus size={14} aria-hidden /> Добавить вариант
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ol>

        {questions.length === 0 && (
          <div className="empty">
            <h3>Вопросов пока нет</h3>
            <p>Без вопросов бот промолчит, а сообщение клиента сразу станет новой заявкой.</p>
            <button type="button" className="button" onClick={() => setList(COURSE_TEMPLATE())}>
              Заполнить примером про курсы
            </button>
          </div>
        )}

        <div className="add-question">
          <button type="button" className="button" onClick={() => setList([...questions, newQuestion("choice")])}>
            <Plus size={16} aria-hidden /> Вопрос с вариантами
          </button>
          <button type="button" className="button" onClick={() => setList([...questions, newQuestion("text")])}>
            <Plus size={16} aria-hidden /> Свободный ответ
          </button>
          <button type="button" className="button" onClick={() => setList([...questions, newQuestion("phone")])}>
            <Plus size={16} aria-hidden /> Телефон
          </button>
        </div>

        <div className="form form-wide">
          <label className="field">
            Сообщение после опроса
            <textarea rows={2} value={completion} onChange={(e) => { setCompletion(e.target.value); touch(); }} maxLength={900} placeholder="Можно оставить пустым." />
          </label>
        </div>

        <div className="save-bar">
          <ErrorNote>{error}</ErrorNote>
          <div className="save-bar-row">
            <button type="button" className="button button-primary" onClick={save} disabled={busy || !dirty}>
              Сохранить опрос
            </button>
            {dirty && <span className="muted">Есть несохранённые изменения</span>}
            {saved && !dirty && <span role="status">Опрос сохранён</span>}
            <span className="grow" />
            {!survey.is_default && (
              <>
                <button type="button" className="link-button" onClick={makeDefault}>
                  Сделать основным
                </button>
                <button type="button" className="link-button link-danger" onClick={() => setConfirmDelete(true)}>
                  Удалить опрос
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <Modal title={`Удалить опрос «${survey.name}»?`} onClose={() => setConfirmDelete(false)}>
          <div className="stack">
            <p>Каналы этого опроса перейдут на основной. Заявки и ответы останутся.</p>
            <div className="button-row">
              <button type="button" className="button button-danger" onClick={remove}>
                Удалить опрос
              </button>
              <button type="button" className="button" onClick={() => setConfirmDelete(false)}>
                Оставить
              </button>
            </div>
          </div>
        </Modal>
      )}

      <aside className="preview" aria-label="Как это увидит клиент">
        <h2>Как это увидит клиент</h2>
        <ol className="chat chat-preview">
          <li className="bubble bubble-contact">
            <p>Привет</p>
          </li>
          {welcome.trim() && (
            <li className="bubble bubble-bot">
              <p>{welcome}</p>
            </li>
          )}
          {preview.map((q) => (
            <li key={q.id} className="bubble bubble-bot">
              <p>
                {q.text}
                {q.type === "choice" && q.allow_other ? "\n\nВыберите вариант или напишите свой." : ""}
              </p>
              {(q.type === "choice" || !q.required) && (
                <ul className="bubble-options">
                  {q.type === "choice" && q.options.filter((o) => o.label.trim()).map((o) => <li key={o.id}>{o.label}</li>)}
                  {!q.required && <li>Пропустить</li>}
                </ul>
              )}
            </li>
          ))}
          {completion.trim() && (
            <li className="bubble bubble-bot">
              <p>{completion}</p>
            </li>
          )}
        </ol>
      </aside>
    </div>
  );
}
