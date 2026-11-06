import type { Adapter, Platform } from "../types.ts";
import { telegram } from "./telegram.ts";
import { facebook, instagram, whatsapp } from "./meta.ts";
import { viber } from "./viber.ts";
import { vk } from "./vk.ts";

// Новая соцсеть: файл с реализацией Adapter и строка здесь.
export const adapters: Record<Platform, Adapter> = { telegram, instagram, facebook, whatsapp, viber, vk };
