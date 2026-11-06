import type { Option, OutMessage } from "./types.ts";

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Режет длинный текст по переносам и пробелам. У Instagram лимит в байтах, а кириллица занимает по 2 байта. */
export function splitText(text: string, limit: { chars?: number; bytes?: number }): string[] {
  const fits = (s: string) =>
    (limit.chars === undefined || s.length <= limit.chars) && (limit.bytes === undefined || byteLength(s) <= limit.bytes);

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0 && !fits(rest)) {
    let end = Math.min(rest.length, limit.chars ?? rest.length);
    while (end > 1 && !fits(rest.slice(0, end))) end = Math.floor(end * 0.9);
    const window = rest.slice(0, end);
    const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = breakAt > end * 0.5 ? breakAt : end;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export interface FittedMessage {
  text: string;
  buttons: Option[];
}

/**
 * Подгоняет варианты под лимиты платформы. Если подпись не влезает в кнопку,
 * варианты нумеруются в тексте, а на кнопках остаются номера. Если не влезает
 * число кнопок, остаётся только нумерованный список: клиент отвечает цифрой.
 */
export function fitOptions(message: OutMessage, limit: { maxLabel: number; maxButtons: number }): FittedMessage {
  const options = message.options ?? [];
  if (options.length === 0) return { text: message.text, buttons: [] };

  const numbered = () => `${message.text}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}`;
  if (options.length > limit.maxButtons) return { text: numbered(), buttons: [] };
  if (options.every((o) => o.label.length <= limit.maxLabel)) return { text: message.text, buttons: options };
  return { text: numbered(), buttons: options.map((o, i) => ({ id: o.id, label: String(i + 1) })) };
}

export const optionPayload = (id: string) => `o:${id}`;

export function parseOptionPayload(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("o:") ? value.slice(2) : undefined;
}
