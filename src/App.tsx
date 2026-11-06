import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { BookOpen, Building2, Inbox, ListChecks, LogOut, Plug, ShieldCheck, Users } from "lucide-react";
import { Logo } from "./components/ui";
import { daysLeft, longDate } from "./lib/format";
import { isConfigured, supabase } from "./lib/supabase";
import type { Access, Membership, Workspace } from "./lib/types";
import { AuthPage } from "./pages/AuthPage";
import { ChannelsPage } from "./pages/ChannelsPage";
import { LeadsPage } from "./pages/LeadsPage";
import { LessonsPage } from "./pages/LessonsPage";
import { PlatformPage } from "./pages/PlatformPage";
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

function Message({ title, children, action = true }: { title: string; children: React.ReactNode; action?: boolean }) {
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

function ExitButton() {
  return (
    <button type="button" className="rail-link rail-exit" onClick={signOut}>
      <LogOut size={22} aria-hidden /> Выйти
    </button>
  );
}

function CabinetShell({ workspace, isPlatformAdmin, children }: { workspace: Workspace; isPlatformAdmin: boolean; children: React.ReactNode }) {
  const isOwner = workspace.role === "owner";
  const left = workspace.access_until ? daysLeft(workspace.access_until) : null;
  return (
    <div className="shell">
      <nav className="rail" aria-label="Разделы">
        <span className="logo"><Logo /></span>
        <NavLink to="/leads" className="rail-link">
          <Inbox size={22} aria-hidden /> Заявки
        </NavLink>
        <NavLink to="/lessons" className="rail-link">
          <BookOpen size={22} aria-hidden /> Уроки
        </NavLink>
        {isOwner && (
          <NavLink to="/questions" className="rail-link">
            <ListChecks size={22} aria-hidden /> Вопросы
          </NavLink>
        )}
        {isOwner && (
          <NavLink to="/channels" className="rail-link">
            <Plug size={22} aria-hidden /> Каналы
          </NavLink>
        )}
        <NavLink to="/team" className="rail-link">
          <Users size={22} aria-hidden /> Команда
        </NavLink>
        {isPlatformAdmin && (
          <NavLink to="/platform" className="rail-link">
            <ShieldCheck size={22} aria-hidden /> Админка
          </NavLink>
        )}
        <ExitButton />
      </nav>
      <div className="stage">
        {left !== null && left <= 7 && (
          <p className="stage-banner" role="status">
            Доступ заканчивается {longDate(workspace.access_until!)}. Чтобы продлить его, обратитесь к администратору Qabul.
          </p>
        )}
        <div className="stage-body">{children}</div>
      </div>
    </div>
  );
}

function PlatformShell({ membership, children }: { membership: Membership | undefined; children: React.ReactNode }) {
  return (
    <div className="shell">
      <nav className="rail rail-platform" aria-label="Разделы главного админа">
        <span className="logo"><Logo /></span>
        <span className="rail-note">Главный админ</span>
        <NavLink to="/platform" className="rail-link">
          <Building2 size={22} aria-hidden /> Компании
        </NavLink>
        {membership?.active && (
          <NavLink to="/leads" className="rail-link">
            <Inbox size={22} aria-hidden /> Мой кабинет
          </NavLink>
        )}
        <ExitButton />
      </nav>
      <div className="stage">
        <div className="stage-body">{children}</div>
      </div>
    </div>
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
    setAccess(error ? null : (data as Access));
  }, [userId]);

  useEffect(() => {
    loadAccess();
  }, [loadAccess]);

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

  const platformRoute = isPlatformAdmin ? (
    <PlatformShell membership={membership}>
      <PlatformPage />
    </PlatformShell>
  ) : (
    <Navigate to="/" replace />
  );

  // Кабинет компании: с истёкшим сроком вместо него показывается понятное сообщение.
  let cabinet: React.ReactNode;
  if (!membership) {
    cabinet = isPlatformAdmin ? (
      <Navigate to="/platform" replace />
    ) : (
      <Message title="Кабинет не найден">Этот аккаунт не привязан к компании. Обратитесь к администратору Qabul.</Message>
    );
  } else if (!membership.active) {
    cabinet = isPlatformAdmin ? (
      <Navigate to="/platform" replace />
    ) : membership.is_suspended ? (
      <Message title="Доступ приостановлен">Доступ компании «{membership.name}» приостановлен. Бот сейчас не отвечает клиентам. Обратитесь к администратору Qabul.</Message>
    ) : (
      <Message title="Срок доступа закончился">
        Доступ {membership.access_until ? `закончился ${longDate(membership.access_until)}` : "закончился"}. Бот сейчас не отвечает клиентам, данные сохранены. Чтобы продлить доступ, обратитесь к администратору Qabul.
      </Message>
    );
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
            <Route path="/questions" element={isOwner ? <SurveysPage /> : <Navigate to="/leads" replace />} />
            <Route path="/channels" element={isOwner ? <ChannelsPage /> : <Navigate to="/leads" replace />} />
            <Route path="/team" element={<TeamPage />} />
            <Route path="*" element={<Navigate to="/leads" replace />} />
          </Routes>
        </CabinetShell>
      </AppContext.Provider>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to={isPlatformAdmin ? "/platform" : "/leads"} replace />} />
      <Route path="/platform" element={platformRoute} />
      <Route path="*" element={cabinet} />
    </Routes>
  );
}
