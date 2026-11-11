export type Platform = "telegram" | "instagram" | "facebook" | "whatsapp" | "viber" | "vk";

export const PLATFORMS: Platform[] = ["telegram", "instagram", "facebook", "whatsapp", "viber", "vk"];
export const META_PLATFORMS: Platform[] = ["instagram", "facebook", "whatsapp"];

export interface Credentials {
  token: string;
  appSecret?: string;
  phoneNumberId?: string;
  wabaId?: string;
  /** Аккаунт Instagram для токенов Facebook: у них /me указывает не на него. */
  accountId?: string;
}

export interface Identity {
  externalId: string;
  name: string;
  username?: string;
  tokenExpiresAt?: string | null;
}

export interface Option {
  id: string;
  label: string;
}

export interface OutMessage {
  text: string;
  options?: Option[];
}

export interface ContactRef {
  externalId: string;
  meta?: Record<string, unknown>;
}

export interface SendContext {
  creds: Credentials;
  channelName: string;
  contact: ContactRef;
}

export interface ActivateContext {
  creds: Credentials;
  identity: Identity;
  webhookUrl: string;
  secret: string;
  saveExtra: (patch: Record<string, unknown>) => Promise<void>;
}

export interface Profile {
  displayName?: string;
  username?: string;
}

export interface Adapter {
  /** Проверяет токен и возвращает аккаунт, которому он принадлежит. */
  identify(creds: Credentials): Promise<Identity>;
  /** Подключает webhook у платформы. */
  activate(ctx: ActivateContext): Promise<void>;
  deactivate(creds: Credentials): Promise<void>;
  /** Отправляет сообщение и возвращает его id на платформе. */
  send(ctx: SendContext, message: OutMessage): Promise<string | undefined>;
  fetchProfile?(creds: Credentials, externalUserId: string): Promise<Profile | null>;
}

export interface CustomerMessage {
  kind: "message";
  externalUserId: string;
  messageId: string;
  text?: string;
  optionId?: string;
  attachment?: string;
  displayName?: string;
  username?: string;
  contactMeta?: Record<string, unknown>;
  ack?: (creds: Credentials) => Promise<void>;
}

/** Владелец сам написал клиенту, минуя CRM (Telegram Business). */
export interface OwnerMessage {
  kind: "owner_message";
  externalUserId: string;
  messageId: string;
  text?: string;
}

export type InboundEvent = CustomerMessage | OwnerMessage;

/** Ошибка, текст которой можно показать владельцу на сайте. */
export class ChannelError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ChannelError";
  }
}
