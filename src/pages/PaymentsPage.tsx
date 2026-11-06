import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { useApp } from "../App";
import { Empty, ErrorNote } from "../components/ui";
import { fullTime, money } from "../lib/format";
import { errorText, supabase } from "../lib/supabase";
import type { LessonStudent } from "../lib/types";

type Row = LessonStudent & { lessons: { id: string; title: string; starts_at: string | null } | null };

interface Person {
  key: string;
  name: string;
  phone: string | null;
  paid: number;
  /** Долг за прошедшие уроки и уроки без даты. */
  debt: number;
  /** Ещё не наступившие уроки: это будущая оплата, а не долг. */
  upcoming: number;
  lines: Row[];
}

const PAGE = 1000;
const isUpcoming = (row: Row) => Boolean(row.lessons?.starts_at && new Date(row.lessons.starts_at).getTime() > Date.now());
const ATTENDED: Record<string, string> = { true: "пришёл", false: "не пришёл" };

export function PaymentsPage() {
  const { workspace } = useApp();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const all: Row[] = [];
    // Supabase отдаёт не больше 1000 строк за раз, а итоги должны считаться по всем.
    for (let from = 0; ; from += PAGE) {
      const { data, error: e } = await supabase
        .from("lesson_students")
        .select("*, lessons(id, title, starts_at)")
        .eq("workspace_id", workspace.id)
        .or("price.gt.0,paid.gt.0")
        .order("created_at")
        .range(from, from + PAGE - 1);
      if (e) {
        setError(`Не удалось загрузить оплаты: ${e.message}`);
        return;
      }
      all.push(...(data as Row[]));
      if (data.length < PAGE) break;
    }
    setError("");
    setRows(all);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  const people = useMemo(() => {
    const map = new Map<string, Person>();
    for (const row of rows ?? []) {
      const key = row.contact_id ?? `${row.name.trim().toLowerCase()}|${row.phone ?? ""}`;
      const person = map.get(key) ?? { key, name: row.name, phone: row.phone, paid: 0, debt: 0, upcoming: 0, lines: [] };
      person.paid += row.paid;
      if (isUpcoming(row)) person.upcoming += row.debt;
      else person.debt += row.debt;
      if (row.debt > 0) person.lines.push(row);
      map.set(key, person);
    }
    return [...map.values()].sort((a, b) => b.debt - a.debt || b.upcoming - a.upcoming);
  }, [rows]);

  const totals = useMemo(
    () => people.reduce((sum, p) => ({ paid: sum.paid + p.paid, debt: sum.debt + p.debt, upcoming: sum.upcoming + p.upcoming }), { paid: 0, debt: 0, upcoming: 0 }),
    [people],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((p) => p.lines.length > 0 && (!q || p.name.toLowerCase().includes(q) || p.phone?.includes(q)));
  }, [people, query]);

  async function markPaid(row: Row) {
    setError("");
    const { error: e } = await supabase.from("lesson_students").update({ paid: row.price }).eq("id", row.id);
    if (e) setError(errorText(e));
    await load();
  }

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>Оплаты</h1>
          <p className="muted">Кто сколько заплатил и кто должен. Суммы и посещаемость отмечаются в уроке.</p>
        </div>
      </header>

      <ErrorNote>{error}</ErrorNote>
      {rows === null && !error && <p className="muted">Загружаем оплаты…</p>}

      {rows !== null && rows.length === 0 && (
        <Empty title="Оплат пока нет">
          <p>Укажите цену в <Link to="/lessons">уроке</Link>, и здесь появятся ученики, которые ещё не заплатили.</p>
        </Empty>
      )}

      {rows !== null && rows.length > 0 && (
        <>
          <div className="pay-stats">
            <div className="pay-stat"><span>Оплачено</span><strong>{money(totals.paid)}</strong></div>
            <div className="pay-stat"><span>Долг</span><strong className={totals.debt > 0 ? "debt" : ""}>{money(totals.debt)}</strong></div>
            <div className="pay-stat"><span>Ожидается за будущие уроки</span><strong>{money(totals.upcoming)}</strong></div>
          </div>

          <label className="search pay-search">
            <Search size={16} aria-hidden />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Имя или телефон" aria-label="Найти ученика" />
          </label>

          {visible.length === 0 && <p className="muted pad">{query.trim() ? "Никого не нашли." : "Все ученики оплатили уроки."}</p>}

          <ul className="pay-people">
            {visible.map((person) => (
              <li className="pay-person" key={person.key}>
                <div className="pay-head">
                  <span>
                    <strong>{person.name}</strong>
                    {person.phone && <a href={`tel:${person.phone}`}>{person.phone}</a>}
                  </span>
                  <span className="pay-sum">
                    {person.debt > 0 && <span className="debt">Долг {money(person.debt)}</span>}
                    {person.debt > 0 && person.upcoming > 0 && ", "}
                    {person.upcoming > 0 && <span className="muted">ожидается {money(person.upcoming)}</span>}
                  </span>
                </div>
                <ul className="pay-lines">
                  {person.lines.map((row) => (
                    <li className="pay-line" key={row.id}>
                      <span>
                        <Link to={`/lessons/${row.lesson_id}`}>{row.lessons?.title}</Link>
                        <span className="muted">
                          {row.lessons?.starts_at ? `, ${fullTime(row.lessons.starts_at)}` : ""}
                          {row.attended !== null ? `, ${ATTENDED[String(row.attended)]}` : ""}
                        </span>
                      </span>
                      <span className="pay-line-side">
                        <span className="pay-sum">{money(row.debt)}</span>
                        <button type="button" className="button" onClick={() => markPaid(row)} aria-label={`${person.name} оплатил полностью: ${row.lessons?.title ?? "урок"}`}>
                          Оплатил
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
