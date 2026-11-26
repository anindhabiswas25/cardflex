"use client";
// Background music for the whole app (lib/music.ts). It starts after the
// player's first tap (browsers don't allow sound before that) when the Music
// setting is on, and fades out when it's switched off.
import { useEffect } from "react";
import { installAudioUnlock, isUnlocked, onUnlock } from "@/lib/audio";
import { startMusic, stopMusic } from "@/lib/music";
import { readSettings, subscribeSettings, type Settings } from "@/lib/settings";

export function MusicPlayer() {
  useEffect(() => {
    installAudioUnlock();
    const apply = (s: Settings) => {
      if (!s.music) stopMusic();
      else if (isUnlocked()) void startMusic();
    };
    const offUnlock = onUnlock(() => apply(readSettings()));
    const offSettings = subscribeSettings(apply);
    return () => {
      offUnlock();
      offSettings();
    };
  }, []);
  return null;
}
