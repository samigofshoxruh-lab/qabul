import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

/** Переписка прочитана или отправлено сообщение: значок обновляется сразу. */
export const SUPPORT_CHANGED = "qabul-support-changed";

/** Число непрочитанных сообщений поддержки для значка в меню. */
export function useSupportUnread(asPlatform: boolean, enabled = true): number {
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc("support_unread", { p_as_platform: asPlatform });
    if (typeof data === "number") setCount(data);
  }, [asPlatform]);

  useEffect(() => {
    if (!enabled) return;
    load();
    const live = supabase
      .channel(`support-unread-${asPlatform}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "support_messages" }, () => load())
      .subscribe();
    const timer = setInterval(load, 15_000);
    window.addEventListener(SUPPORT_CHANGED, load);
    return () => {
      supabase.removeChannel(live);
      clearInterval(timer);
      window.removeEventListener(SUPPORT_CHANGED, load);
    };
  }, [asPlatform, enabled, load]);

  return count;
}
