import type { Lead, LeadStatus } from "./types";

const timeFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const fullFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

export function shortTime(value: string): string {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dayFormat.format(date);
}

export const fullTime = (value: string) => fullFormat.format(new Date(value));

export const STATUS_LABEL: Record<LeadStatus, string> = {
  collecting: "Бот опрашивает",
  new: "Новая",
  in_work: "В работе",
  done: "Завершена",
  rejected: "Отказ",
};

export function contactName(lead: Pick<Lead, "contacts">): string {
  const c = lead.contacts;
  return c?.display_name || (c?.username ? `@${c.username}` : "") || c?.phone || "Без имени";
}

/** Значение для CSV. Текст клиента, начинающийся с =, + или @, Excel выполнил бы как формулу. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^\+?\d+$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
export const longDate = (value: string) => dateFormat.format(new Date(value)).replace(/\s*г\.$/, "");

const moneyFormat = new Intl.NumberFormat("ru-RU");
export const money = (value: number) => `${moneyFormat.format(value)} сум`;
/** Число для поля ввода: «800 000». Ноль показываем пустым полем. */
export const moneyInput = (value: number) => (value ? moneyFormat.format(value) : "");
export const parseMoney = (value: string) => Number(value.replace(/\D/g, "")) || 0;

const dayMs = 86_400_000;

export function daysLeft(until: string): number {
  return Math.ceil((new Date(until).getTime() - Date.now()) / dayMs);
}

export function accessLabel(until: string | null, suspended = false): { text: string; tone: "ok" | "wait" | "bad" } {
  if (suspended) return { text: "Доступ приостановлен", tone: "bad" };
  if (!until) return { text: "Бессрочный доступ", tone: "ok" };
  const days = daysLeft(until);
  if (days <= 0) return { text: `Срок закончился ${longDate(until)}`, tone: "bad" };
  return { text: `До ${longDate(until)}, осталось ${days} дн.`, tone: days <= 7 ? "wait" : "ok" };
}

/** Значение для поля даты и времени в часовом поясе пользователя. */
export function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function randomPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint32Array(12)), (n) => alphabet[n % alphabet.length]).join("");
}
