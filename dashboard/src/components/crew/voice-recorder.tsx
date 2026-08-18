'use client';

// Microphone capture for the Crew chat.
//
// MediaRecorder produces different containers per browser — iOS/macOS
// Safari records audio/mp4 (m4a), Chrome records webm/opus. The server
// sniffs magic bytes, so we just pick the first supported type.
//
// getUserMedia only exists in secure contexts: the HTTPS dashboard URL or
// localhost. On the plain-HTTP tailnet address the mic is unavailable and
// start() reports a helpful error instead of throwing.

import { useEffect, useRef, useState } from 'react';

const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

// Hard stop so a forgotten live mic can't record forever.
const MAX_RECORDING_S = 180;

export interface VoiceRecorder {
  recording: boolean;
  /** Seconds since recording started. */
  elapsed: number;
  /** Set when start() failed — mic missing, denied, or insecure context. */
  error: string | null;
  start: () => Promise<boolean>;
  /** Stops and resolves with the recorded audio, or null if nothing captured. */
  stop: () => Promise<Blob | null>;
  cancel: () => void;
}

export function useVoiceRecorder(): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopResolveRef = useRef<((blob: Blob | null) => void) | null>(null);

  function teardown() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const session = sessionRef.current;
    if (session) {
      for (const track of session.stream.getTracks()) track.stop();
      sessionRef.current = null;
    }
    setRecording(false);
    setElapsed(0);
  }

  async function start(): Promise<boolean> {
    setError(null);
    if (sessionRef.current) return true;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Microphone needs the HTTPS address — open cortex.kylebehrend.com');
      return false;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone permission denied');
      return false;
    }

    const mimeType = MIME_CANDIDATES.find(
      (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
    );

    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      for (const track of stream.getTracks()) track.stop();
      setError('Recording is not supported in this browser');
      return false;
    }

    const session = { recorder, stream, chunks: [] as Blob[] };
    sessionRef.current = session;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) session.chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob =
        session.chunks.length > 0
          ? new Blob(session.chunks, { type: recorder.mimeType || 'audio/webm' })
          : null;
      const resolve = stopResolveRef.current;
      stopResolveRef.current = null;
      teardown();
      resolve?.(blob);
    };

    recorder.start(250);
    setRecording(true);
    setElapsed(0);
    timerRef.current = setInterval(() => {
      setElapsed((prev) => {
        if (prev + 1 >= MAX_RECORDING_S && sessionRef.current) {
          try {
            sessionRef.current.recorder.stop();
          } catch {
            /* already stopped */
          }
        }
        return prev + 1;
      });
    }, 1000);
    return true;
  }

  function stop(): Promise<Blob | null> {
    const session = sessionRef.current;
    if (!session) return Promise.resolve(null);
    return new Promise((resolve) => {
      stopResolveRef.current = resolve;
      try {
        session.recorder.stop();
      } catch {
        stopResolveRef.current = null;
        teardown();
        resolve(null);
      }
    });
  }

  function cancel() {
    const session = sessionRef.current;
    if (!session) return;
    // Drop the data: clear chunks before stop so onstop resolves null.
    session.chunks.length = 0;
    stopResolveRef.current = null;
    try {
      session.recorder.stop();
    } catch {
      teardown();
    }
  }

  // Release the mic if the component unmounts mid-recording.
  useEffect(() => teardown, []);

  return { recording, elapsed, error, start, stop, cancel };
}

export function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
