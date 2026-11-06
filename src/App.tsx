import { createContext, useCallback, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { BookOpen, Building2, Inbox, LifeBuoy, ListChecks, LogOut, Menu, Plug, ShieldCheck, Users, Wallet } from "lucide-react";
import { Logo, Modal } from "./components/ui";
import { type ChannelProblem, useChannelProblems } from "./lib/alerts";
import { daysLeft, longDate } from "./lib/format";
import { isConfigured, supabase } from "./lib/supabase";
import { SUPPORT_CHANGED, useSupportUnread } from "./lib/support";
import type { Access, Membership, Workspace } from "./lib/types";
import { AuthPage } from "./pages/AuthPage";
import { ChannelsPage } from "./pages/ChannelsPage";
import { LeadsPage } from "./pages/LeadsPage";
import { LessonsPage } from "./pages/LessonsPage";
import { PaymentsPage } from "./pages/PaymentsPage";
import { PlatformPage } from "./pages/PlatformPage";
import { PlatformSupportPage } from "./pages/PlatformSupportPage";
import { OwnerSupport, SupportPage } from "./pages/SupportPage";
import { SurveysPage } from "./pages/SurveysPage";
import { TeamPage } from "./pages/TeamPage";

interface AppContextValue {
  workspace: Workspace;
  userId: string;
  reloadWorkspace: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("Нет контекста приложения");
  return value;
}

const signOut = () => supabase.auth.signOut();

function Message({ title, children, action = true }: { title: string; children: ReactNode; action?: boolean }) {
  return (
    <main className="center-screen">
      <div className="center-box">
        <Logo size={48} />
        <h1>{title}</h1>
        <p>{children}</p>
        {action && (
          <button type="button" className="button" onClick={signOut}>
            Выйти
          </button>
        )}
      </div>
    </main>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  badge?: number;
  badgeLabel?: string;
  /** На телефоне остаётся в нижнем меню, остальное уходит в «Ещё». */
  primary?: boolean;
  isActive?: (path: string) => boolean;
}

function RailLink({ item, secondary, onNavigate }: { item: NavItem; secondary?: boolean; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const active = item.isActive ? item.isActive(pathname) : pathname === item.to || pathname.startsWith(`${item.to}/`);
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={`rail-link ${active ? "active" : ""} ${secondary ? "is-secondary" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
    >
      <span className="rail-icon">
        <Icon size={22} aria-hidden />
        {Boolean(item.badge) && <span className="rail-badge" aria-label={`${item.badgeLabel ?? "Непрочитанных"}: ${item.badge}`}>{item.badge}</span>}
      </span>
      {item.label}
    </Link>
  );
}

/** На компьютере полная колонка слева, на телефоне нижнее меню максимум из пяти пунктов. */
function Rail({ items, platform, note }: { items: NavItem[]; platform?: boolean; note?: string }) {
  const [moreOpen, setMoreOpen] = useState(false);
  // Выход тоже считается: всего в нижнем меню помещается пять пунктов.
  const useMore = items.length + 1 > 5;
  const primary = useMore ? items.filter((i) => i.primary) : items;
  const secondary = useMore ? items.filter((i) => !i.primary) : [];
  const { pathname } = useLocation();
  const moreActive = secondary.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));

  return (
    <nav className={`rail ${platform ? "rail-platform" : ""}`} aria-label="Разделы">
      <span className="logo"><Logo /></span>
      {note && <span className="rail-note">{note}</span>}
      {primary.map((item) => (
        <RailLink key={item.to} item={item} />
      ))}
      {secondary.map((item) => (
        <RailLink key={item.to} item={item} secondary />
      ))}
      {useMore && (
        <button type="button" className={`rail-link rail-more ${moreActive ? "active" : ""}`} onClick={() => setMoreOpen(true)}>
          <span className="rail-icon"><Menu size={22} aria-hidden /></span>
          Ещё
        </button>
      )}
      <button type="button" className={`rail-link rail-exit ${useMore ? "is-secondary" : ""}`} onClick={signOut}>
        <span className="rail-icon"><LogOut size={22} aria-hidden /></span>
        Выйти
      </button>

      {moreOpen && (
        <Modal title="Ещё" onClose={() => setMoreOpen(false)}>
          <div className="more-menu">
            {secondary.map((item) => (
              <RailLink key={item.to} item={item} onNavigate={() => setMoreOpen(false)} />
            ))}
            <button type="button" className="rail-link" onClick={signOut}>
              <span className="rail-icon"><LogOut size={22} aria-hidden /></span>
              Выйти
            </button>
          </div>
        </Modal>
      )}
    </nav>
  );
}

function ChannelBanner({ problems, isOwner }: { problems: ChannelProblem[]; isOwner: boolean }) {
  const { pathname } = useLocation();
  if (problems.length === 0 || pathname.startsWith("/channels")) return null;
  const names = problems.map((p) => p.name).join(", ");
  return (
    <p className="stage-banner stage-banner-bad" role="alert">
      {problems.length === 1 ? `Канал ${names} не работает. ${problems[0].reason}` : `Не работают каналы: ${names}.`}{" "}
      {isOwner ? <Link to="/channels">Открыть каналы</Link> : "Сообщите об этом владельцу компании."}
    </p>
  );
}

function CabinetShell({ workspace, isPlatformAdmin, children }: { workspace: Workspace; isPlatformAdmin: boolean; children: ReactNode }) {
  const isOwner = workspace.role === "owner";
  const left = workspace.access_until ? daysLeft(workspace.access_until) : null;
  const unread = useSupportUnread(false, isOwner);
  const channelProblems = useChannelProblems(workspace.id);

  const items: NavItem[] = [
    { to: "/leads", label: "Заявки", icon: Inbox, primary: true },
    { to: "/lessons", label: "Уроки", icon: BookOpen, primary: true },
    { to: "/payments", label: "Оплаты", icon: Wallet },
    ...(isOwner
      ? [
          { to: "/questions", label: "Вопросы", icon: ListChecks, primary: true },
          { to: "/channels", label: "Каналы", icon: Plug, badge: channelProblems.length, badgeLabel: "Каналов с проблемой" },
        ]
      : []),
    { to: "/team", label: "Команда", icon: Users },
    ...(isOwner ? [{ to: "/support", label: "Поддержка", icon: LifeBuoy, badge: unread, primary: true }] : []),
    ...(isPlatformAdmin ? [{ to: "/platform", label: "Админка", icon: ShieldCheck }] : []),
  ];

  return (
    <div className="shell">
      <Rail items={items} />
      <div className="stage">
        {left !== null && left <= 7 && (
          <p className="stage-banner" role="status">
            Доступ заканчивается {longDate(workspace.access_until!)}, осталось {left} дн. После этого бот перестанет отвечать клиентам.{" "}
            {isOwner ? <Link to="/support">Написать в поддержку</Link> : "Чтобы продлить его, обратитесь к владельцу компании."}
          </p>
        )}
        <ChannelBanner problems={channelProblems} isOwner={isOwner} />
        <div className="stage-body">{children}</div>
      </div>
    </div>
  );
}

function PlatformShell({ membership, children }: { membership: Membership | undefined; children: ReactNode }) {
  const unread = useSupportUnread(true);
  const items: NavItem[] = [
    {
      to: "/platform",
      label: "Компании",
      icon: Building2,
      primary: true,
      isActive: (path) => path.startsWith("/platform") && !path.startsWith("/platform/support"),
    },
    { to: "/platform/support", label: "Поддержка", icon: LifeBuoy, badge: unread, primary: true },
    ...(membership?.active ? [{ to: "/leads", label: "Мой кабинет", icon: Inbox, primary: true }] : []),
  ];
  return (
    <div className="shell">
      <Rail items={items} platform note="Главный админ" />
      <div className="stage">
        <div className="stage-body">{children}</div>
      </div>
    </div>
  );
}

function ExpiredOwner({ membership }: { membership: Membership }) {
  return (
    <main className="expired-page">
      <div className="expired-head">
        <Logo size={44} />
        <button type="button" className="link-button" onClick={signOut}>
          Выйти
        </button>
      </div>
      <h1>{membership.is_suspended ? "Доступ приостановлен" : "Срок доступа закончился"}</h1>
      <p>Бот сейчас не отвечает клиентам, данные компании сохранены. Напишите нам, и мы всё решим.</p>
      <OwnerSupport workspaceId={membership.workspace_id} accessUntil={membership.access_until} suspended={membership.is_suspended} />
    </main>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [access, setAccess] = useState<Access | null | undefined>(undefined);

  useEffect(() => {
    if (!isConfigured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;

  const loadAccess = useCallback(async () => {
    if (!userId) {
      setAccess(undefined);
      return;
    }
    const { data, error } = await supabase.rpc("my_access");
    setAccess((previous) => {
      // Короткий сбой сети не должен закрывать уже открытый кабинет.
      if (error) return previous ?? null;
      return JSON.stringify(previous) === JSON.stringify(data) ? previous : (data as Access);
    });
  }, [userId]);

  // Срок может измениться, пока сайт открыт: перечитываем его при новом сообщении поддержки,
  // при возврате на вкладку и на всякий случай раз в 30 секунд.
  useEffect(() => {
    loadAccess();
    if (!userId) return;
    const timer = setInterval(loadAccess, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") loadAccess();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(SUPPORT_CHANGED, loadAccess);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(SUPPORT_CHANGED, loadAccess);
    };
  }, [loadAccess, userId]);

  if (!isConfigured) {
    return (
      <Message title="Подключите Supabase" action={false}>
        Создайте файл <code>.env</code> по образцу <code>.env.example</code>, укажите адрес проекта и publishable key, затем перезапустите сайт.
      </Message>
    );
  }
  if (session === undefined) return <main className="center-screen" aria-busy="true" />;
  if (!session) return <AuthPage />;
  if (access === undefined) return <main className="center-screen" aria-busy="true" />;
  if (access === null) return <Message title="Не удалось загрузить кабинет">Проверьте интернет и обновите страницу.</Message>;

  const isPlatformAdmin = access.is_platform_admin;
  const membership = access.memberships[0];

  const inPlatform = (page: ReactNode) =>
    isPlatformAdmin ? <PlatformShell membership={membership}>{page}</PlatformShell> : <Navigate to="/" replace />;

  // Кабинет компании: с истёкшим сроком владелец попадает на экран с поддержкой.
  let cabinet: ReactNode;
  if (!membership) {
    cabinet = isPlatformAdmin ? (
      <Navigate to="/platform" replace />
    ) : (
      <Message title="Кабинет не найден">Этот аккаунт не привязан к компании. Обратитесь к администратору Qabul.</Message>
    );
  } else if (!membership.active) {
    if (isPlatformAdmin) {
      cabinet = <Navigate to="/platform" replace />;
    } else if (membership.role === "owner") {
      cabinet = <ExpiredOwner membership={membership} />;
    } else {
      cabinet = (
        <Message title={membership.is_suspended ? "Доступ приостановлен" : "Срок доступа закончился"}>
          Доступ к компании закрыт. Обратитесь к её владельцу.
        </Message>
      );
    }
  } else {
    const workspace: Workspace = {
      id: membership.workspace_id,
      name: membership.name,
      role: membership.role,
      access_until: membership.access_until,
    };
    const isOwner = workspace.role === "owner";
    cabinet = (
      <AppContext.Provider value={{ workspace, userId: session.user.id, reloadWorkspace: loadAccess }}>
        <CabinetShell workspace={workspace} isPlatformAdmin={isPlatformAdmin}>
          <Routes>
            <Route path="/leads" element={<LeadsPage />} />
            <Route path="/leads/:leadId" element={<LeadsPage />} />
            <Route path="/lessons" element={<LessonsPage />} />
            <Route path="/lessons/:lessonId" element={<LessonsPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/questions" element={isOwner ? <SurveysPage /> : <Navigate to="/leads" replace />} />
            <Route path="/channels" element={isOwner ? <ChannelsPage /> : <Navigate to="/leads" replace />} />
            <Route path="/team" element={<TeamPage />} />
            <Route
              path="/support"
              element={isOwner ? <SupportPage workspaceId={workspace.id} accessUntil={workspace.access_until} /> : <Navigate to="/leads" replace />}
            />
            <Route path="*" element={<Navigate to="/leads" replace />} />
          </Routes>
        </CabinetShell>
      </AppContext.Provider>
    );
  }

  const companies = <PlatformPage onAccessChanged={loadAccess} />;
  const support = <PlatformSupportPage onActivity={() => undefined} />;

  return (
    <Routes>
      <Route path="/" element={<Navigate to={isPlatformAdmin ? "/platform" : "/leads"} replace />} />
      <Route path="/platform" element={inPlatform(companies)} />
      <Route path="/platform/c/:companyId" element={inPlatform(companies)} />
      <Route path="/platform/support" element={inPlatform(support)} />
      <Route path="/platform/support/:workspaceId" element={inPlatform(support)} />
      <Route path="*" element={cabinet} />
    </Routes>
  );
}
