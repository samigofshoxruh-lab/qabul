import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { SupportChat } from "../components/SupportChat";
import { Empty, ErrorNote } from "../components/ui";
import { accessLabel, longDate, shortTime } from "../lib/format";
import { callFunction, errorText, supabase } from "../lib/supabase";
import type { Company, SupportThread } from "../lib/types";

export function PlatformSupportPage({ onActivity }: { onActivity: () => void }) {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const [threads, setThreads] = useState<SupportThread[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [error, setError] = useState("");

  const loadThreads = useCallback(async () => {
    const { data, error: e } = await supabase.rpc("platform_support_threads");
    if (e) setError(e.message);
    else setThreads(data as SupportThread[]);
  }, []);

  const loadCompanies = useCallback(async () => {
    try {
      const { companies: list } = await callFunction<{ companies: Company[] }>("platform", { action: "overview" });
      setCompanies(list);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    loadThreads();
    loadCompanies();
    const live = supabase
      .channel("support-threads")
      .on("postgres_changes", { event: "*", schema: "public", table: "support_messages" }, () => loadThreads())
      .subscribe();
    const timer = setInterval(loadThreads, 10_000);
    return () => {
      supabase.removeChannel(live);
      clearInterval(timer);
    };
  }, [loadThreads, loadCompanies]);

  const company = useMemo(() => companies.find((c) => c.id === workspaceId) ?? null, [companies, workspaceId]);

  return (
    <div className={`leads ${workspaceId ? "has-detail" : ""}`}>
      <section className="lead-list" aria-label="Обращения">
        <header className="lead-list-head lessons-head">
          <h1>Поддержка</h1>
        </header>
        <ErrorNote>{error}</ErrorNote>
        {threads === null && !error && <p className="muted pad">Загружаем обращения…</p>}
        <ul className="rows">
          {threads?.length === 0 && (
            <li className="pad">
              <Empty title="Обращений пока нет">
                <p>Здесь появятся сообщения от владельцев компаний.</p>
              </Empty>
            </li>
          )}
          {threads?.map((thread) => (
            <li key={thread.workspace_id}>
              <button
                type="button"
                className={`row ${thread.workspace_id === workspaceId ? "is-selected" : ""}`}
                aria-current={thread.workspace_id === workspaceId ? "true" : undefined}
                onClick={() => navigate(`/platform/support/${thread.workspace_id}`)}
              >
                <span className="row-main">
                  <span className="row-name">{thread.name}</span>
                  <span className="row-preview">
                    {thread.last_sender === "platform" ? "Вы: " : ""}
                    {thread.last_text}
                  </span>
                </span>
                <span className="row-side">
                  <time dateTime={thread.last_at}>{shortTime(thread.last_at)}</time>
                  {thread.unread > 0 && (
                    <span className="count count-strong" aria-label={`Непрочитанных: ${thread.unread}`}>
                      {thread.unread}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="lead-detail" aria-label="Переписка">
        {workspaceId ? (
          <PlatformThread
            key={workspaceId}
            workspaceId={workspaceId}
            company={company}
            onChanged={async () => {
              await Promise.all([loadCompanies(), loadThreads()]);
            }}
            onActivity={() => {
              loadThreads();
              onActivity();
            }}
          />
        ) : (
          <div className="detail-empty">
            <p>Выберите обращение, чтобы ответить владельцу.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function PlatformThread({
  workspaceId,
  company,
  onChanged,
  onActivity,
}: {
  workspaceId: string;
  company: Company | null;
  onChanged: () => Promise<void>;
  onActivity: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  // Продление прямо из переписки: владелец сразу видит новую дату в чате.
  async function extend(months: number) {
    setBusy(true);
    setError("");
    try {
      const { access_until } = await callFunction<{ access_until: string }>("platform", { action: "set_access", workspace_id: workspaceId, add_months: months });
      const { error: e } = await supabase.rpc("support_send", {
        p_workspace: workspaceId,
        p_text: `Доступ продлён до ${longDate(access_until)}.`,
        p_as_platform: true,
      });
      if (e) throw e;
      setReloadKey((k) => k + 1);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const status = company ? accessLabel(company.access_until, company.is_suspended) : null;

  return (
    <article className="support-page support-thread">
      <header className="thread-head">
        <button type="button" className="icon-button back" onClick={() => navigate("/platform/support")} aria-label="Назад к обращениям">
          <ArrowLeft size={20} aria-hidden />
        </button>
        <div className="thread-who">
          <h2>{company?.name ?? "Компания"}</h2>
          {status && <p className={`tone-${status.tone}`}>{status.text}</p>}
        </div>
        <Link className="thread-open" to={`/platform/c/${workspaceId}`}>
          Открыть компанию
        </Link>
      </header>
      <div className="quick-row" role="group" aria-label="Продлить доступ">
        <span className="quick-label">Продлить:</span>
        {[1, 3, 6, 12].map((months) => (
          <button key={months} type="button" className="chip" disabled={busy} onClick={() => extend(months)}>
            +{months} мес.
          </button>
        ))}
      </div>
      <ErrorNote>{error}</ErrorNote>
      <SupportChat
        workspaceId={workspaceId}
        asPlatform
        reloadKey={reloadKey}
        onActivity={onActivity}
        emptyText="Сообщений пока нет. Напишите владельцу первым."
      />
    </article>
  );
}
