import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { useApp } from "../App";
import { ChannelTag, CopyField, ErrorNote, Modal } from "../components/ui";
import { CHANNELS_CHANGED, tokenExpired } from "../lib/alerts";
import { fullTime, longDate } from "../lib/format";
import { PLATFORM_ORDER, PLATFORMS } from "../lib/platforms";
import { callFunction, errorText, supabase } from "../lib/supabase";
import type { Channel, Platform, Survey } from "../lib/types";

type SurveyWithCount = Survey & { questions: { count: number }[] };

interface Setup {
  callback_url: string;
  verify_token: string;
}

const WEBHOOK_FIELDS: Partial<Record<Platform, string>> = {
  instagram: "В приложении Meta откройте Use cases → Instagram → Customize → блок Configure webhooks. Вставьте адрес и Verify token, нажмите Verify and save, затем включите поле messages.",
  facebook: "В приложении Meta откройте Messenger → Settings → Webhooks.",
  whatsapp: "В приложении Meta откройте WhatsApp → Configuration → Webhook.",
};

function WebhookSetup({ platform, setup, channelId, onDone }: { platform: Platform; setup: Setup; channelId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function check() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await callFunction<{ warning: string | null }>("channels", { action: "check", channel_id: channelId });
      if (result.warning) setError(result.warning);
      else setMessage("Токен работает, подписка включена. Напишите в аккаунт с другого профиля: сообщение появится в заявках.");
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <ol className="steps">
        <li>{WEBHOOK_FIELDS[platform]}</li>
        <li>Вставьте эти значения и подтвердите. Meta сразу проверит адрес.</li>
      </ol>
      <CopyField label="Callback URL" value={setup.callback_url} />
      <CopyField label="Verify token" value={setup.verify_token} />
      <ol className="steps" start={3}>
        <li>Подпишитесь на поле <code>messages</code>{platform !== "whatsapp" && <> и <code>messaging_postbacks</code></>}.</li>
        <li>Нажмите кнопку ниже, чтобы включить подписку вашего аккаунта.</li>
      </ol>
      <ErrorNote>{error}</ErrorNote>
      {message && <p className="note" role="status">{message}</p>}
      <button type="button" className="button button-primary" onClick={check} disabled={busy}>
        {busy ? "Проверяем…" : "Проверить подключение"}
      </button>
    </div>
  );
}

function ConnectForm({ platform, onClose, onChanged }: { platform: Platform; onClose: () => void; onChanged: () => void }) {
  const { workspace } = useApp();
  const info = PLATFORMS[platform];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState<{ channel: Channel; setup: Setup | null; warning: string | null } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await callFunction<{ channel: Channel; setup: Setup | null; warning: string | null }>("channels", {
        action: "connect",
        workspace_id: workspace.id,
        platform,
        ...values,
      });
      onChanged();
      if (result.setup) setConnected(result);
      else onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={connected ? `Настройка ${info.label}` : `Подключить ${info.label}`} onClose={onClose}>
      {connected?.setup ? (
        <WebhookSetup platform={platform} setup={connected.setup} channelId={connected.channel.id} onDone={onChanged} />
      ) : (
        <form className="stack" onSubmit={submit}>
          <ol className="steps">
            {info.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {info.caution && (
            <p className="note note-attention">
              <AlertTriangle size={16} aria-hidden /> <span>{info.caution}</span>
            </p>
          )}
          {info.fields.map((field) => (
            <label className="field" key={field.key}>
              {field.label}
              <input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                required
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
            </label>
          ))}
          <ErrorNote>{error}</ErrorNote>
          <button className="button button-primary" disabled={busy}>
            {busy ? "Проверяем токен…" : "Подключить"}
          </button>
        </form>
      )}
    </Modal>
  );
}

function statusText(channel: Channel): { text: string; tone: "ok" | "wait" | "bad" } {
  if (!channel.is_active) return { text: "Бот выключен", tone: "wait" };
  if (tokenExpired(channel)) return { text: "Токен истёк, бот не отвечает", tone: "bad" };
  if (channel.status === "error") return { text: "Ошибка подключения", tone: "bad" };
  if (channel.last_error) return { text: "Есть проблема, бот может не отвечать", tone: "bad" };
  if (channel.last_event_at) return { text: `Работает, последнее сообщение ${fullTime(channel.last_event_at)}`, tone: "ok" };
  if (channel.status === "active") return { text: "Подключён, ждём первое сообщение", tone: "ok" };
  return { text: "Ждём настройку webhook и первое сообщение", tone: "wait" };
}

function ChannelRow({ channel, surveys, onChanged, onReplaceToken }: { channel: Channel; surveys: SurveyWithCount[]; onChanged: () => void; onReplaceToken: (platform: Platform) => void }) {
  const info = PLATFORMS[channel.platform];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  async function act(body: Record<string, unknown>, after?: () => void) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await callFunction<{ warning?: string | null; setup?: Setup }>("channels", { ...body, channel_id: channel.id });
      if (result.warning) setError(result.warning);
      after?.();
      if (result.setup) setSetup(result.setup);
      if (body.action === "check" && !result.warning) setNotice("Токен работает.");
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function patch(fields: Partial<Channel>) {
    const { error: e } = await supabase.from("channels").update(fields).eq("id", channel.id);
    if (e) setError(e.message);
    onChanged();
  }

  const status = statusText(channel);
  const survey = surveys.find((s) => (channel.survey_id ? s.id === channel.survey_id : s.is_default));
  const noQuestions = survey !== undefined && (survey.questions[0]?.count ?? 0) === 0;
  const expiresIn = channel.token_expires_at ? (new Date(channel.token_expires_at).getTime() - Date.now()) / 86_400_000 : null;

  return (
    <li className="channel">
      <div className="channel-main">
        <ChannelTag platform={channel.platform} />
        <div className="channel-who">
          <h3>{channel.name}</h3>
          <p className="muted">
            {info.label}
            {channel.username ? `, ${channel.platform === "telegram" ? "@" : ""}${channel.username.replace(/^@/, "")}` : ""}
            {channel.token_hint ? `, токен ${channel.token_hint}` : ""}
          </p>
          {channel.platform === "instagram" && channel.token_expires_at && !tokenExpired(channel) && (
            <p className="muted">Токен продлевается автоматически, сейчас действует до {longDate(channel.token_expires_at)}.</p>
          )}
          {channel.platform === "instagram" && !channel.token_expires_at && (
            <p className="muted">Токен без срока действия, продлевать его не нужно.</p>
          )}
          <p className={`channel-status tone-${status.tone}`}>{status.text}</p>
        </div>
        <div className="channel-controls">
          <label className="field field-inline">
            Опрос
            <select value={channel.survey_id ?? ""} onChange={(e) => patch({ survey_id: e.target.value || null })}>
              <option value="">Основной</option>
              {surveys.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={channel.is_active} onChange={(e) => patch({ is_active: e.target.checked })} />
            Бот включён
          </label>
        </div>
      </div>

      {channel.last_error && <ErrorNote>{channel.last_error}</ErrorNote>}
      {noQuestions && (
        <p className="note note-attention">
          <span>
            В опросе нет вопросов: бот промолчит, а сообщения сразу станут заявками. <Link to="/questions">Добавить вопросы</Link>
          </span>
        </p>
      )}
      {expiresIn !== null && expiresIn < 7 && (
        <p className="note note-attention">
          {expiresIn < 0 ? "Токен истёк." : `Токен истекает через ${Math.ceil(expiresIn)} дн.`} Выпустите новый и обновите его здесь.
        </p>
      )}
      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="note" role="status">{notice}</p>}

      <div className="channel-actions">
        <button type="button" className="link-button" onClick={() => act({ action: "check" })} disabled={busy}>
          Проверить
        </button>
        {info.manualWebhook && (
          <button type="button" className="link-button" onClick={() => act({ action: "setup" })} disabled={busy}>
            Настройка webhook
          </button>
        )}
        <button type="button" className="link-button" onClick={() => onReplaceToken(channel.platform)}>
          Обновить токен
        </button>
        <button type="button" className="link-button link-danger" onClick={() => setConfirmOff(true)}>
          Отключить
        </button>
      </div>

      {setup && (
        <Modal title={`Настройка ${info.label}`} onClose={() => setSetup(null)}>
          <WebhookSetup platform={channel.platform} setup={setup} channelId={channel.id} onDone={onChanged} />
        </Modal>
      )}
      {confirmOff && (
        <Modal title={`Отключить ${channel.name}?`} onClose={() => setConfirmOff(false)}>
          <div className="stack">
            <p>Бот перестанет отвечать в этом канале, токен будет удалён. Заявки и переписка останутся на сайте.</p>
            <div className="button-row">
              <button type="button" className="button button-danger" disabled={busy} onClick={() => act({ action: "disconnect" }, () => setConfirmOff(false))}>
                Отключить канал
              </button>
              <button type="button" className="button" onClick={() => setConfirmOff(false)}>
                Оставить
              </button>
            </div>
          </div>
        </Modal>
      )}
    </li>
  );
}

export function ChannelsPage() {
  const { workspace } = useApp();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [surveys, setSurveys] = useState<SurveyWithCount[]>([]);
  const [connecting, setConnecting] = useState<Platform | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([
      supabase.from("channels").select("*").eq("workspace_id", workspace.id).is("deleted_at", null).order("created_at"),
      supabase.from("surveys").select("*, questions(count)").eq("workspace_id", workspace.id).order("created_at"),
    ]);
    if (c.error || s.error) {
      setError((c.error ?? s.error)!.message);
      return;
    }
    setChannels(c.data as Channel[]);
    setSurveys(s.data as SurveyWithCount[]);
    // Меню и предупреждение наверху сразу узнают, что канал починили или отключили.
    window.dispatchEvent(new Event(CHANNELS_CHANGED));
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>Каналы</h1>
          <p className="muted">Соцсети, в которых бот отвечает клиентам. Токены хранятся зашифрованными и не показываются повторно.</p>
        </div>
      </header>

      <ErrorNote>{error}</ErrorNote>

      {channels && channels.length > 0 && (
        <ul className="channel-list">
          {channels.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} surveys={surveys} onChanged={load} onReplaceToken={setConnecting} />
          ))}
        </ul>
      )}

      <h2 className="section-title">Подключить</h2>
      <ul className="platform-list">
        {PLATFORM_ORDER.map((platform) => (
          <li key={platform}>
            <button type="button" className="platform" onClick={() => setConnecting(platform)}>
              <ChannelTag platform={platform} />
              <span>
                <strong>{PLATFORMS[platform].label}</strong>
                <span className="muted">{PLATFORMS[platform].summary}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {connecting && <ConnectForm platform={connecting} onClose={() => setConnecting(null)} onChanged={load} />}
    </main>
  );
}
