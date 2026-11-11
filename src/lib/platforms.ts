import type { Platform } from "./types";

export interface PlatformField {
  key: "token" | "app_secret" | "phone_number_id" | "waba_id" | "account_id";
  label: string;
  placeholder?: string;
  secret?: boolean;
}

export interface PlatformInfo {
  label: string;
  code: string;
  color: string;
  summary: string;
  steps: string[];
  fields: PlatformField[];
  /** Webhook настраивается вручную в кабинете разработчика Meta. */
  manualWebhook?: boolean;
  caution?: string;
}

const META_REVIEW =
  "Пока приложение Meta не в режиме Live и не прошло App Review (Advanced Access и Business Verification), сообщения приходят только от людей с ролью в приложении, а не от обычных клиентов.";

export const PLATFORMS: Record<Platform, PlatformInfo> = {
  telegram: {
    label: "Telegram",
    code: "TG",
    color: "#1C7ED6",
    summary: "Бот или ваш личный аккаунт. Достаточно токена.",
    steps: [
      "Откройте @BotFather, отправьте /newbot и скопируйте токен.",
      "Вставьте токен ниже. Остальное настроится само.",
      "Чтобы бот отвечал от вашего личного аккаунта: в @BotFather включите Business Mode, затем в Telegram откройте Настройки → Telegram для бизнеса → Чат-боты и выберите этого бота.",
    ],
    fields: [{ key: "token", label: "Токен бота", placeholder: "123456789:AA...", secret: true }],
  },
  instagram: {
    label: "Instagram",
    code: "IG",
    color: "#C2255C",
    summary: "Директ профессионального аккаунта. Нужно приложение Meta.",
    steps: [
      "Переведите аккаунт в Business или Creator. В приложении Instagram включите Настройки → Сообщения → «Разрешить доступ к сообщениям».",
      "На developers.facebook.com откройте приложение → Use cases → Manage messaging & content on Instagram → Customize → API setup with Unified login (в старых приложениях: Instagram → API setup with Instagram login).",
      "В блоке Generate access tokens нажмите Add account, войдите в аккаунт школы, затем Generate token → Copy. Подойдёт токен любого вида: и IG…, и EAA….",
      "App Secret: App settings → Basic → App secret → Show. В старых приложениях это Instagram App Secret на странице Instagram login.",
      "Следующим шагом сайт покажет Callback URL и Verify token для блока Configure webhooks.",
    ],
    fields: [
      { key: "token", label: "Access token", secret: true },
      { key: "app_secret", label: "App Secret", secret: true },
      { key: "account_id", label: "Instagram account ID, если сайт не нашёл аккаунт сам", placeholder: "Число под названием аккаунта в блоке Generate access tokens" },
    ],
    manualWebhook: true,
    caution: META_REVIEW,
  },
  facebook: {
    label: "Facebook",
    code: "FB",
    color: "#2B59C3",
    summary: "Messenger вашей страницы. Нужно приложение Meta.",
    steps: [
      "На developers.facebook.com откройте приложение и добавьте продукт Messenger.",
      "Выпустите Page access token для своей страницы (разрешения pages_messaging и pages_manage_metadata).",
      "Скопируйте App Secret из App settings → Basic и вставьте значения ниже.",
      "Следующим шагом сайт покажет Callback URL и Verify token для раздела Webhooks.",
    ],
    fields: [
      { key: "token", label: "Page access token", secret: true },
      { key: "app_secret", label: "App Secret", secret: true },
    ],
    manualWebhook: true,
    caution: META_REVIEW,
  },
  whatsapp: {
    label: "WhatsApp",
    code: "WA",
    color: "#2B8A3E",
    summary: "WhatsApp Business Cloud API. Нужно приложение Meta.",
    steps: [
      "На developers.facebook.com откройте приложение и добавьте продукт WhatsApp.",
      "В API Setup скопируйте Phone number ID и WhatsApp Business Account ID.",
      "Выпустите постоянный токен System User с правами whatsapp_business_messaging и whatsapp_business_management.",
      "Следующим шагом сайт покажет Callback URL и Verify token для раздела Webhooks.",
    ],
    fields: [
      { key: "token", label: "Токен System User", secret: true },
      { key: "phone_number_id", label: "Phone number ID" },
      { key: "waba_id", label: "WhatsApp Business Account ID" },
      { key: "app_secret", label: "App Secret", secret: true },
    ],
    manualWebhook: true,
    caution: "Переведите приложение Meta в режим Live, иначе сообщения клиентов на сайт не придут.",
  },
  viber: {
    label: "Viber",
    code: "VB",
    color: "#7048B6",
    summary: "Бот Viber. Создаётся на платных условиях Viber.",
    steps: [
      "Оформите бота через Viber или партнёра: с февраля 2024 новые боты создаются только на коммерческих условиях.",
      "Скопируйте токен в разделе «Edit info» панели администратора бота.",
      "Вставьте токен ниже. Webhook настроится сам.",
    ],
    fields: [{ key: "token", label: "Токен бота", secret: true }],
  },
  vk: {
    label: "ВКонтакте",
    code: "VK",
    color: "#2F6DB5",
    summary: "Сообщения сообщества. Достаточно ключа доступа.",
    steps: [
      "В сообществе откройте Управление → Сообщения и включите сообщения.",
      "В разделе Работа с API создайте ключ с правами «Управление сообществом» и «Сообщения».",
      "Вставьте ключ ниже. Сервер Callback API добавится сам.",
    ],
    fields: [{ key: "token", label: "Ключ доступа сообщества", secret: true }],
  },
};

export const PLATFORM_ORDER: Platform[] = ["telegram", "instagram", "facebook", "whatsapp", "viber", "vk"];
