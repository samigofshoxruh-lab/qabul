import { useCallback, useEffect, useState } from "react";
import type { Channel } from "./types";
import { supabase } from "./supabase";

/** Каналы изменились на сайте: меню и предупреждение обновляются сразу. */
export const CHANNELS_CHANGED = "qabul-channels-changed";

const POLL_MS = 60_000;

export const tokenExpired = (channel: Pick<Channel, "token_expires_at">) =>
  Boolean(channel.token_expires_at && new Date(channel.token_expires_at).getTime() < Date.now());

export interface ChannelProblem {
  id: string;
  name: string;
  reason: string;
}

function problemOf(channel: Channel): ChannelProblem | null {
  if (!channel.is_active) return null;
  const reason = tokenExpired(channel)
    ? "Токен истёк, выпустите новый."
    : channel.last_error ?? (channel.status === "error" ? "Ошибка подключения." : null);
  return reason ? { id: channel.id, name: channel.name, reason } : null;
}

/** Каналы компании с проблемой: список обновляется сам, пока сайт открыт. */
export function useChannelProblems(workspaceId: string): ChannelProblem[] {
  const [problems, setProblems] = useState<ChannelProblem[]>([]);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("channels")
      .select("id, name, is_active, status, last_error, token_expires_at")
      .eq("workspace_id", workspaceId)
      .is("deleted_at", null);
    if (error) return;
    const next = (data as Channel[]).map(problemOf).filter((p): p is ChannelProblem => p !== null);
    setProblems((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [workspaceId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(CHANNELS_CHANGED, load);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(CHANNELS_CHANGED, load);
    };
  }, [load]);

  return problems;
}
