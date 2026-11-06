import { useState, type FormEvent } from "react";
import { ErrorNote, Logo } from "../components/ui";
import { errorText, supabase } from "../lib/supabase";

const SAMPLE = [
  { q: "Какой курс вас интересует?", a: "Английский язык" },
  { q: "Когда удобно прийти на первое занятие?", a: "Суббота, 10:00" },
  { q: "Как вас зовут?", a: "Мадина" },
  { q: "Номер телефона", a: "+998 90 123 45 67" },
];

export function AuthPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { error: e } = await supabase.auth.signInWithPassword({ email, password });
      if (e) throw e;
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(code === "invalid_credentials" ? "Неверный email или пароль." : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <section className="auth-intro">
        <p className="brand">
          <Logo size={44} /> Qabul
        </p>
        <h1>Клиент пишет «привет», а вы получаете готовую анкету</h1>
        <p className="auth-lead">
          Бот сам задаёт ваши вопросы в Telegram, Instagram, Facebook, WhatsApp, Viber и ВКонтакте. Ответы сразу появляются на сайте, и
          администратор берёт заявку в работу.
        </p>
        <dl className="sheet sheet-sample" aria-label="Пример заполненной анкеты">
          {SAMPLE.map((row) => (
            <div className="sheet-row" key={row.q}>
              <dt>{row.q}</dt>
              <dd>
                <mark>{row.a}</mark>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="auth-form-wrap">
        <form className="form auth-form" onSubmit={submit}>
          <h2>Вход</h2>
          <label className="field">
            Email
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            Пароль
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <ErrorNote>{error}</ErrorNote>
          <button className="button button-primary" disabled={busy}>
            Войти
          </button>
          <p className="muted auth-hint">Нет аккаунта или забыли пароль? Обратитесь к администратору Qabul.</p>
        </form>
      </section>
    </main>
  );
}
