import { useState } from "react";
import { SupportChat } from "../components/SupportChat";
import { accessLabel } from "../lib/format";

const PERIODS = [
  { short: "1 мес.", label: "1 месяц" },
  { short: "3 мес.", label: "3 месяца" },
  { short: "6 мес.", label: "6 месяцев" },
  { short: "12 мес.", label: "12 месяцев" },
];

const periodText = (label: string) => `Здравствуйте! Прошу продлить доступ на ${label}.`;

/** Запрос продления и переписка. Используется и на странице раздела, и на экране с истёкшим сроком. */
export function OwnerSupport({
  workspaceId,
  accessUntil,
  suspended = false,
  onActivity,
}: {
  workspaceId: string;
  accessUntil: string | null;
  suspended?: boolean;
  onActivity?: () => void;
}) {
  const [preset, setPreset] = useState<{ text: string; key: number } | null>(null);
  const status = accessLabel(accessUntil, suspended);

  return (
    <>
      <p className={`support-status tone-${status.tone}`}>{status.text}</p>
      <div className="quick-row" role="group" aria-label="Запросить продление">
        <span className="quick-label">Продлить на:</span>
        {PERIODS.map((p) => (
          <button key={p.label} type="button" className="chip" onClick={() => setPreset({ text: periodText(p.label), key: Date.now() })}>
            {p.short}
          </button>
        ))}
      </div>
      <SupportChat
        workspaceId={workspaceId}
        asPlatform={false}
        preset={preset}
        onActivity={onActivity}
        emptyText="Напишите нам о проблеме или попросите продлить доступ. Отвечает администратор Qabul."
      />
    </>
  );
}

export function SupportPage({ workspaceId, accessUntil, onActivity }: { workspaceId: string; accessUntil: string | null; onActivity?: () => void }) {
  return (
    <main className="support-page">
      <h1>Поддержка Qabul</h1>
      <OwnerSupport workspaceId={workspaceId} accessUntil={accessUntil} onActivity={onActivity} />
    </main>
  );
}
