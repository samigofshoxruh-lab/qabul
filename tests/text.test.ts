// deno test --allow-env tests/text.test.ts
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { fitOptions, splitText } from "../supabase/functions/_shared/text.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;

Deno.test("короткий текст не режется", () => {
  assertEquals(splitText("Привет", { chars: 100 }), ["Привет"]);
});

Deno.test("кириллица режется по байтам для Instagram", () => {
  const text = "Слово ".repeat(400);
  const chunks = splitText(text, { bytes: 1000 });
  assert(chunks.length > 1);
  for (const chunk of chunks) assert(bytes(chunk) <= 1000, `${bytes(chunk)} байт`);
  assertEquals(chunks.join(" ").replace(/\s+/g, " ").trim(), text.replace(/\s+/g, " ").trim());
});

Deno.test("сплошной текст без пробелов тоже режется", () => {
  const chunks = splitText("я".repeat(1500), { bytes: 1000 });
  for (const chunk of chunks) assert(bytes(chunk) <= 1000);
  assertEquals(chunks.join(""), "я".repeat(1500));
});

Deno.test("лимит в символах", () => {
  const chunks = splitText("a".repeat(5000), { chars: 2000 });
  assertEquals(chunks.map((c) => c.length), [2000, 2000, 1000]);
});

Deno.test("подписи помещаются в кнопки без изменений", () => {
  const options = [{ id: "a", label: "Суббота" }, { id: "b", label: "Воскресенье" }];
  assertEquals(fitOptions({ text: "Когда?", options }, { maxLabel: 20, maxButtons: 13 }), { text: "Когда?", buttons: options });
});

Deno.test("длинная подпись: варианты в тексте, на кнопках номера с теми же id", () => {
  const options = [{ id: "a", label: "Суббота, 10:00, Чиланзар, филиал 2" }, { id: "b", label: "Вс" }];
  const fitted = fitOptions({ text: "Когда?", options }, { maxLabel: 20, maxButtons: 13 });
  assertEquals(fitted.text, "Когда?\n\n1. Суббота, 10:00, Чиланзар, филиал 2\n2. Вс");
  assertEquals(fitted.buttons, [{ id: "a", label: "1" }, { id: "b", label: "2" }]);
});

Deno.test("кнопок больше лимита: только нумерованный список", () => {
  const options = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, label: `Вариант ${i}` }));
  const fitted = fitOptions({ text: "Выбор", options }, { maxLabel: 20, maxButtons: 3 });
  assertEquals(fitted.buttons, []);
  assert(fitted.text.includes("5. Вариант 4"));
});
