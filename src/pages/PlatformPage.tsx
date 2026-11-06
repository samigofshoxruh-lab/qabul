import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, LifeBuoy, Plus, Search, Trash2 } from "lucide-react";
import { ChannelTag, CopyField, Empty, ErrorNote, Modal } from "../components/ui";
import { accessLabel, longDate, randomPassword } from "../lib/format";
import { callFunction, errorText } from "../lib/supabase";
import type { Company, CompanyMember } from "../lib/types";

const TERMS = [
  { value: "1", label: "1 месяц" },
  { value: "3", label: "3 месяца" },
  { value: "6", label: "6 месяцев" },
  { value: "12", label: "12 месяцев" },
  { value: "date", label: "До конкретной даты" },
  { value: "unlimited", label: "Бессрочно" },
];

/** Конец выбранного дня в часовом поясе пользователя. */
const endOfDay = (date: string) => new Date(`${date}T23:59:59`).toISOString();

const siteAddress = () => `${window.location.origin}${window.location.pathname}`;

function PasswordField({ value, onChange, label = "Пароль" }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label className="field">
      {label}
      <span className="password-row">
        <input value={value} onChange={(e) => onChange(e.target.value)} minLength={8} autoComplete="off" spellCheck={false} required />
        <button type="button" className="button" onClick={() => onChange(randomPassword())}>
          Придумать
        </button>
      </span>
    </label>
  );
}

function Credentials({ email, password }: { email: string; password: string }) {
  return (
    <div className="stack">
      <p>Передайте эти данные клиенту. Пароль больше нигде не показывается.</p>
      <CopyField label="Адрес сайта" value={siteAddress()} />
      <CopyField label="Email" value={email} />
      <CopyField label="Пароль" value={password} />
    </div>
  );
}

function CreateCompany({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(randomPassword);
  const [term, setTerm] = useState("1");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const period =
        term === "unlimited" ? { unlimited: true } : term === "date" ? { until: endOfDay(until) } : { months: Number(term) };
      const result = await callFunction<{ workspace_id: string }>("platform", { action: "create_company", name, email, password, ...period });
      await onCreated(result.workspace_id);
      setCreated(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={created ? "Компания создана" : "Новая компания"} onClose={onClose}>
      {created ? (
        <Credentials email={email.trim().toLowerCase()} password={password} />
      ) : (
        <form className="stack" onSubmit={submit}>
          <label className="field">
            Название компании
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          </label>
          <label className="field">
            Email владельца
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
          </label>
          <PasswordField value={password} onChange={setPassword} />
          <label className="field">
            Срок доступа
            <select value={term} onChange={(e) => setTerm(e.target.value)}>
              {TERMS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {term === "date" && (
            <label className="field">
              Доступ открыт до
              <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} required />
            </label>
          )}
          <ErrorNote>{error}</ErrorNote>
          <button className="button button-primary" disabled={busy}>
            {busy ? "Создаём…" : "Создать компанию"}
          </button>
        </form>
      )}
    </Modal>
  );
}

export function PlatformPage({ onAccessChanged }: { onAccessChanged: () => void }) {
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const { companyId } = useParams();
  const navigate = useNavigate();
  const selectedId = companyId ?? null;
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<Company | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const { companies: list } = await callFunction<{ companies: Company[] }>("platform", { action: "overview" });
      setCompanies(list);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (companies ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.members.some((m) => m.email?.toLowerCase().includes(q)));
  }, [companies, query]);

  const selected = companies?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className={`leads ${selected ? "has-detail" : ""}`}>
      <section className="lead-list" aria-label="Компании">
        <header className="lead-list-head lessons-head">
          <div className="lead-list-title">
            <h1>Компании</h1>
            <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden /> Новая компания
            </button>
          </div>
          <label className="search search-last">
            <Search size={16} aria-hidden />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Название или email" aria-label="Поиск компаний" />
          </label>
        </header>
        <ErrorNote>{error}</ErrorNote>
        {notice && <p className="note list-note" role="status">{notice}</p>}
        {companies === null && !error && <p className="muted pad">Загружаем компании…</p>}
        <ul className="rows">
          {companies?.length === 0 && (
            <li className="pad">
              <Empty title="Компаний пока нет">
                <p>Создайте первую компанию и передайте клиенту email и пароль.</p>
              </Empty>
            </li>
          )}
          {visible.map((company) => {
            const status = accessLabel(company.access_until, company.is_suspended);
            return (
              <li key={company.id} className="company-row">
                <button
                  type="button"
                  className={`row ${company.id === selectedId ? "is-selected" : ""}`}
                  aria-current={company.id === selectedId ? "true" : undefined}
                  onClick={() => navigate(`/platform/c/${company.id}`)}
                >
                  <span className="row-main">
                    <span className="row-name">{company.name}</span>
                    <span className={`row-preview tone-${status.tone}`}>{status.text}</span>
                  </span>
                  <span className="row-side">
                    <span>{company.members.length} польз.</span>
                    <span>{company.leads_count} заявок</span>
                  </span>
                </button>
                <button type="button" className="icon-button company-delete" onClick={() => setDeleting(company)} aria-label={`Удалить компанию ${company.name}`} title="Удалить компанию">
                  <Trash2 size={18} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="lead-detail" aria-label="Компания">
        {selected ? (
          <CompanyDetail
            key={selected.id}
            company={selected}
            onChanged={async () => {
              await load();
              onAccessChanged();
            }}
            onBack={() => navigate("/platform")}
            onDelete={() => setDeleting(selected)}
          />
        ) : (
          <div className="detail-empty">
            <p>Выберите компанию, чтобы изменить срок доступа и пользователей.</p>
          </div>
        )}
      </section>

      {creating && (
        <CreateCompany
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            await load();
            navigate(`/platform/c/${id}`, { replace: true });
          }}
        />
      )}
      {deleting && (
        <DeleteCompany
          company={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async (message) => {
            setDeleting(null);
            setNotice(message);
            navigate("/platform", { replace: true });
            await load();
            onAccessChanged();
          }}
        />
      )}
    </div>
  );
}

function CompanyDetail({
  company,
  onChanged,
  onBack,
  onDelete,
}: {
  company: Company;
  onChanged: () => Promise<void>;
  onBack: () => void;
  onDelete: () => void;
}) {
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(company.name);
  const [addingUser, setAddingUser] = useState(false);
  const [passwordFor, setPasswordFor] = useState<CompanyMember | null>(null);
  const [termFor, setTermFor] = useState<CompanyMember | null>(null);
  const [removing, setRemoving] = useState<CompanyMember | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await callFunction("platform", { workspace_id: company.id, ...body });
      await onChanged();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const status = accessLabel(company.access_until, company.is_suspended);
  // Личный срок раньше срока компании: человек потеряет доступ раньше остальных.
  const earlier = company.members.filter(
    (m) => m.access_until && (!company.access_until || new Date(m.access_until) < new Date(company.access_until)),
  );

  return (
    <article className="company-detail">
      <header className="company-title">
        <button type="button" className="icon-button back" onClick={onBack} aria-label="Назад к списку">
          <ArrowLeft size={20} aria-hidden />
        </button>
        <h2>{company.name}</h2>
      </header>

      <div className="company-actions">
        <Link className="button" to={`/platform/support/${company.id}`}>
          <LifeBuoy size={16} aria-hidden /> Написать владельцу
        </Link>
        <button type="button" className="button" onClick={() => { setNewName(company.name); setRenaming(true); }}>
          Переименовать
        </button>
        <button type="button" className="button button-danger" onClick={onDelete}>
          <Trash2 size={16} aria-hidden /> Удалить компанию
        </button>
      </div>

      <p className="company-facts">
        <span>Создана {longDate(company.created_at)}</span>
        <span>Заявок: {company.leads_count}</span>
        <span>
          Каналы:{" "}
          {company.channels.length === 0
            ? "не подключены"
            : company.channels.map((platform, i) => <ChannelTag key={`${platform}${i}`} platform={platform} />)}
        </span>
      </p>

      <ErrorNote>{error}</ErrorNote>

      <section className="panel" aria-label="Срок доступа">
        <h3>Срок доступа</h3>
        <p className={`panel-status tone-${status.tone}`}>{status.text}</p>
        <div className="button-row">
          {[1, 3, 6, 12].map((months) => (
            <button key={months} type="button" className="button" disabled={busy} onClick={() => act({ action: "set_access", add_months: months })}>
              +{months} мес.
            </button>
          ))}
          <button type="button" className="button" disabled={busy || company.access_until === null} onClick={() => act({ action: "set_access", unlimited: true })}>
            Бессрочно
          </button>
        </div>
        <form
          className="date-row"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await act({ action: "set_access", until: endOfDay(date) })) setDate("");
          }}
        >
          <label className="field field-inline">
            До даты
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <button className="button" disabled={busy || !date}>
            Установить
          </button>
        </form>
        <div>
          <button
            type="button"
            className={company.is_suspended ? "button button-primary" : "link-button link-danger"}
            disabled={busy}
            onClick={() => act({ action: "set_suspended", suspended: !company.is_suspended })}
          >
            {company.is_suspended ? "Возобновить доступ" : "Приостановить доступ"}
          </button>
        </div>
        <p className="muted">Когда срок закончился, кабинет закрывается, а бот перестаёт отвечать клиентам. Данные сохраняются.</p>
        {earlier.length > 0 && (
          <div className="note note-attention term-warning">
            <p>
              Личный срок заканчивается раньше срока компании, и продление на него не влияет:{" "}
              {earlier.map((m) => `${m.email} (до ${longDate(m.access_until!)})`).join(", ")}.
            </p>
            <button type="button" className="button" disabled={busy} onClick={() => act({ action: "clear_user_terms" })}>
              Снять личные сроки
            </button>
          </div>
        )}
      </section>

      <section className="panel" aria-label="Пользователи">
        <div className="panel-head">
          <h3>Пользователи</h3>
          <button type="button" className="button" onClick={() => setAddingUser(true)}>
            <Plus size={16} aria-hidden /> Добавить
          </button>
        </div>
        <ul>
          {company.members.map((member) => {
            const personal = member.access_until ? accessLabel(member.access_until) : null;
            return (
              <li className="user-row" key={member.user_id}>
                <span className="user-who">
                  <strong>{member.email}</strong>
                  <span className="muted">{member.role === "owner" ? "Владелец" : "Администратор"}</span>
                  {personal && <span className={`tone-${personal.tone}`}>, личный срок: {personal.text.toLowerCase()}</span>}
                </span>
                <button type="button" className="link-button" onClick={() => setTermFor(member)}>
                  Личный срок
                </button>
                <button type="button" className="link-button" onClick={() => setPasswordFor(member)}>
                  Сменить пароль
                </button>
                <button type="button" className="link-button link-danger" onClick={() => setRemoving(member)}>
                  Удалить
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {renaming && (
        <Modal title="Переименовать компанию" onClose={() => setRenaming(false)}>
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await act({ action: "rename", name: newName })) setRenaming(false);
            }}
          >
            <label className="field">
              Название компании
              <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} required />
            </label>
            <button className="button button-primary" disabled={busy}>
              Сохранить название
            </button>
          </form>
        </Modal>
      )}
      {addingUser && <AddUser companyId={company.id} onChanged={onChanged} onClose={() => setAddingUser(false)} />}
      {passwordFor && <ChangePassword member={passwordFor} onClose={() => setPasswordFor(null)} />}
      {termFor && <PersonalTerm companyId={company.id} member={termFor} onChanged={onChanged} onClose={() => setTermFor(null)} />}
      {removing && (
        <Modal title="Удалить пользователя?" onClose={() => setRemoving(null)}>
          <div className="stack">
            <p>{removing.email} больше не сможет войти. Его ответы клиентам останутся в истории заявок.</p>
            <div className="button-row">
              <button
                type="button"
                className="button button-danger"
                disabled={busy}
                onClick={async () => {
                  await act({ action: "remove_user", user_id: removing.user_id });
                  setRemoving(null);
                }}
              >
                Удалить
              </button>
              <button type="button" className="button" onClick={() => setRemoving(null)}>
                Оставить
              </button>
            </div>
          </div>
        </Modal>
      )}
    </article>
  );
}

function DeleteCompany({ company, onClose, onDeleted }: { company: Company; onClose: () => void; onDeleted: (message: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await callFunction("platform", { action: "delete_company", workspace_id: company.id, confirm: true });
      await onDeleted(`Компания ${company.name} удалена со всеми данными.`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="Удалить компанию?" onClose={onClose}>
      <div className="stack">
        <p><strong>{company.name}</strong></p>
        <p>
          Навсегда удалятся заявки ({company.leads_count}), вся переписка, клиенты, уроки, опросы, каналы с токенами и учётные записи пользователей ({company.members.length}), если они не состоят в другой компании.
        </p>
        <ErrorNote>{error}</ErrorNote>
        <div className="button-row">
          <button type="button" className="button button-danger" disabled={busy} onClick={confirm}>
            {busy ? "Удаляем…" : "Удалить навсегда"}
          </button>
          <button type="button" className="button" onClick={onClose}>
            Оставить
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddUser({ companyId, onChanged, onClose }: { companyId: string; onChanged: () => Promise<void>; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(randomPassword);
  const [role, setRole] = useState("admin");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await callFunction("platform", {
        action: "add_user",
        workspace_id: companyId,
        email,
        password,
        role,
        ...(until ? { until: endOfDay(until) } : {}),
      });
      await onChanged();
      setCreated(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={created ? "Пользователь добавлен" : "Новый пользователь"} onClose={onClose}>
      {created ? (
        <Credentials email={email.trim().toLowerCase()} password={password} />
      ) : (
        <form className="stack" onSubmit={submit}>
          <label className="field">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
          </label>
          <PasswordField value={password} onChange={setPassword} />
          <label className="field">
            Роль
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="admin">Администратор: заявки и уроки</option>
              <option value="owner">Владелец: ещё вопросы, каналы и команда</option>
            </select>
          </label>
          <label className="field">
            Личный срок (необязательно)
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <p className="muted">Если личный срок не указан, действует срок компании.</p>
          <ErrorNote>{error}</ErrorNote>
          <button className="button button-primary" disabled={busy}>
            Добавить пользователя
          </button>
        </form>
      )}
    </Modal>
  );
}

function ChangePassword({ member, onClose }: { member: CompanyMember; onClose: () => void }) {
  const [password, setPassword] = useState(randomPassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await callFunction("platform", { action: "set_password", user_id: member.user_id, password });
      setDone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={done ? "Пароль изменён" : `Новый пароль для ${member.email}`} onClose={onClose}>
      {done ? (
        <Credentials email={member.email ?? ""} password={password} />
      ) : (
        <form className="stack" onSubmit={submit}>
          <PasswordField value={password} onChange={setPassword} label="Новый пароль" />
          <ErrorNote>{error}</ErrorNote>
          <button className="button button-primary" disabled={busy}>
            Сменить пароль
          </button>
        </form>
      )}
    </Modal>
  );
}

function PersonalTerm({ companyId, member, onChanged, onClose }: { companyId: string; member: CompanyMember; onChanged: () => Promise<void>; onClose: () => void }) {
  const [until, setUntil] = useState(member.access_until ? member.access_until.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(value: string | null) {
    setBusy(true);
    setError("");
    try {
      await callFunction("platform", {
        action: "set_user_access",
        workspace_id: companyId,
        user_id: member.user_id,
        ...(value ? { until: endOfDay(value) } : {}),
      });
      await onChanged();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Личный срок: ${member.email}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          save(until);
        }}
      >
        <p>
          Пользователь потеряет доступ в этот день, даже если срок компании ещё идёт.
          {member.role === "owner" ? " У владельца личный срок снимается при каждом продлении компании." : ""}
        </p>
        <label className="field">
          Доступ открыт до
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} required />
        </label>
        <ErrorNote>{error}</ErrorNote>
        <div className="button-row">
          <button className="button button-primary" disabled={busy}>
            Сохранить срок
          </button>
          <button type="button" className="button" disabled={busy || !member.access_until} onClick={() => save(null)}>
            Убрать личный срок
          </button>
        </div>
      </form>
    </Modal>
  );
}
