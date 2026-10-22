"use client";

import React, { useEffect, useState, useRef } from "react";
import DailyIframe, { DailyCall } from "@daily-co/daily-js";
import { publishDailyAppSession, type DailyAppSession } from "../lib/whiteboard/daily-transport";
import {
  DailyProvider,
  useLocalParticipant,
  useLocalSessionId,
  useVideoTrack,
  useAudioTrack,
  useParticipantIds,
  useDaily,
} from "@daily-co/daily-react";

type VideoRoomProps = {
  roomUrl: string | null;
  token: string | null;
};

const CALL_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const ParticipantTile = ({ id }: { id: string }) => {
  const localSessionId = useLocalSessionId();
  const isLocal = id === localSessionId;
  const videoTrack = useVideoTrack(id);
  const audioTrack = useAudioTrack(id);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoTrack?.persistentTrack) return;
    video.srcObject = new MediaStream([videoTrack.persistentTrack]);
    video.muted = true;
    video.volume = 0;
  }, [videoTrack]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isLocal) {
      audio.srcObject = null;
      audio.muted = true;
      audio.volume = 0;
      return;
    }
    if (audioTrack?.persistentTrack) {
      audio.srcObject = new MediaStream([audioTrack.persistentTrack]);
      audio.muted = false;
    }
  }, [audioTrack, isLocal]);

  return (
    <div className="relative bg-neutral-900 rounded-xl overflow-hidden aspect-video sm:aspect-square md:aspect-video flex items-center justify-center">
      {videoTrack?.persistentTrack ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="text-neutral-400 font-medium text-sm">מצלמה כבויה</div>
      )}
      <audio ref={audioRef} autoPlay muted={isLocal} />
    </div>
  );
};

/** Mic / camera only — never expose recording start/stop controls. */
const Controls = () => {
  const localParticipant = useLocalParticipant();
  const daily = useDaily();

  if (!localParticipant || !daily) return null;

  const isAudioEnabled = localParticipant.audio;
  const isVideoEnabled = localParticipant.video;

  const toggleAudio = () => daily.setLocalAudio(!isAudioEnabled);
  const toggleVideo = () => daily.setLocalVideo(!isVideoEnabled);

  return (
    <div className="p-3 bg-white/80 backdrop-blur-md border-t border-neutral-200/80 flex justify-center gap-3">
      <button
        type="button"
        onClick={toggleAudio}
        className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
          isAudioEnabled
            ? "bg-neutral-900 text-white hover:bg-neutral-800"
            : "bg-red-600 text-white hover:bg-red-700"
        }`}
      >
        {isAudioEnabled ? "השתק מיקרופון" : "הפעל מיקרופון"}
      </button>

      <button
        type="button"
        onClick={toggleVideo}
        className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
          isVideoEnabled
            ? "border border-neutral-200 bg-white hover:bg-neutral-50 text-neutral-700"
            : "bg-red-600 text-white hover:bg-red-700"
        }`}
      >
        {isVideoEnabled ? "כבה מצלמה" : "הפעל מצלמה"}
      </button>
    </div>
  );
};

const CallContainer = () => {
  const participantIds = useParticipantIds();

  return (
    <div className="flex flex-col h-full bg-white/80 backdrop-blur-md rounded-2xl overflow-hidden border border-neutral-200/80 shadow-sm">
      <div className="flex-1 p-3 grid grid-cols-1 sm:grid-cols-2 gap-3 overflow-y-auto bg-neutral-100">
        {participantIds.map((id) => (
          <ParticipantTile key={id} id={id} />
        ))}
        {participantIds.length === 0 && (
          <div className="col-span-full h-full flex items-center justify-center text-neutral-500 text-sm font-medium">
            ממתין למשתתפים...
          </div>
        )}
      </div>
      <Controls />
    </div>
  );
};

/**
 * MockVideoBox — shown whenever Daily is unavailable (missing credentials,
 * account billing issue, join failure, etc.).  Deliberately has no error text
 * so the classroom UI stays clean in dev / staging environments.
 */
function MockVideoBox() {
  return (
    <div className="flex flex-col h-full min-h-[220px] w-full items-center justify-center gap-3 bg-white/80 backdrop-blur-md border border-neutral-200/80 rounded-2xl px-6 text-center">
      <div className="h-10 w-10 rounded-full bg-neutral-100 border border-neutral-200 flex items-center justify-center">
        <svg
          className="h-5 w-5 text-neutral-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <rect x="2" y="6" width="13" height="12" rx="2" />
          <path d="m22 8-5 3 5 3V8Z" />
        </svg>
      </div>
      <div className="text-neutral-800 font-medium text-sm">
        חדר וידאו בסביבת בדיקות
      </div>
      <div className="text-neutral-500 text-xs font-medium leading-relaxed max-w-xs">
        ממתין לחיבור — חדר הווידאו זמין כש־Daily מוגדר בסביבת הייצור. ניתן
        להמשיך עם הלוח והצ&apos;אט.
      </div>
    </div>
  );
}

function toDailySession(call: DailyCall): DailyAppSession {
  return {
    sendAppMessage(data, to) {
      call.sendAppMessage(data, to);
    },
    on(event, handler) {
      call.on(event, handler);
    },
    off(event, handler) {
      call.off(event, handler);
    },
  };
}

function destroyDailyCall(call: DailyCall | null | undefined): Promise<void> {
  if (!call || call.isDestroyed()) return Promise.resolve();
  // destroy() yields on leave() before it clears Daily's singleton.
  // Callers must await this before createCallObject(), or Strict Mode
  // throws "Duplicate DailyIframe instances are not allowed".
  return call.destroy().then(() => undefined).catch(() => undefined);
}

export default function VideoRoom({ roomUrl, token }: VideoRoomProps) {
  const [callObject, setCallObject] = useState<DailyCall | null>(null);
  // When Daily is unavailable (bad credentials, billing, join failure, etc.)
  // we fall back to MockVideoBox silently — no red error screen.
  const [dailyFailed, setDailyFailed] = useState(false);
  const callObjectRef = useRef<DailyCall | null>(null);
  const teardownRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    // No credentials in dev → clean placeholder, no error.
    if (!roomUrl || !token) {
      setCallObject(null);
      return;
    }

    let cancelled = false;

    const connect = async () => {
      // Yield once so Strict Mode's simulated unmount can mark this run
      // cancelled before we touch Daily's process-wide call instance.
      await Promise.resolve();
      await teardownRef.current;
      if (cancelled) return;

      const lingering = callObjectRef.current ?? DailyIframe.getCallInstance();
      if (lingering && !lingering.isDestroyed()) {
        teardownRef.current = destroyDailyCall(lingering);
        await teardownRef.current;
      }
      if (cancelled) return;

      const existing = DailyIframe.getCallInstance();
      const co =
        existing && !existing.isDestroyed()
          ? existing
          : DailyIframe.createCallObject({
              audioSource: true,
              videoSource: true,
              inputSettings: { audio: { settings: CALL_AUDIO_CONSTRAINTS } },
            });
      callObjectRef.current = co;
      void co
        .updateInputSettings({ audio: { settings: CALL_AUDIO_CONSTRAINTS } })
        .catch(() => undefined);

      if (cancelled) {
        teardownRef.current = destroyDailyCall(co);
        await teardownRef.current;
        if (callObjectRef.current === co) callObjectRef.current = null;
        return;
      }

      // Best-effort media permission warm-up (failure is non-blocking).
      if (navigator.mediaDevices?.getUserMedia) {
        navigator.mediaDevices
          .getUserMedia({ video: true, audio: CALL_AUDIO_CONSTRAINTS })
          .catch((err: unknown) => {
            console.warn("[VideoRoom] Media permission denied:", err);
          });
      }

      publishDailyAppSession(toDailySession(co));
      setCallObject(co);
      setDailyFailed(false);

      // Listen for Daily error events (e.g. account-missing-payment-method).
      co.on("error", (event) => {
        if (cancelled) return;
        console.warn("[VideoRoom] Daily error event — using fallback:", event);
        setDailyFailed(true);
      });

      co.join({ url: roomUrl, token }).catch((err: unknown) => {
        if (cancelled) return;
        // Swallow join errors silently and fall back to MockVideoBox.
        // Common causes: expired token, room deleted, billing issue.
        console.warn("[VideoRoom] Daily join failed — using fallback:", err);
        setDailyFailed(true);
      });
    };

    void connect();

    return () => {
      cancelled = true;
      publishDailyAppSession(null);
      const co = callObjectRef.current ?? DailyIframe.getCallInstance();
      callObjectRef.current = null;
      setCallObject(null);
      if (co && !co.isDestroyed()) {
        teardownRef.current = destroyDailyCall(co);
      }
    };
  }, [roomUrl, token]);

  // No credentials or Daily failed → silent placeholder.
  if (!roomUrl || !token || dailyFailed) {
    return <MockVideoBox />;
  }

  if (!callObject) {
    return <MockVideoBox />;
  }

  return (
    <DailyProvider callObject={callObject}>
      <div className="h-full w-full min-h-[200px]">
        <CallContainer />
      </div>
    </DailyProvider>
  );
}
