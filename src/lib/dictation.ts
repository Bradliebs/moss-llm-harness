// src/lib/dictation.ts
//
// Push-to-talk microphone capture that transcribes through the main-process
// Whisper endpoint (window.moss.stt.transcribe). Recording happens in the
// renderer (MediaRecorder); the audio bytes are handed to the main process for
// the network POST, so the renderer CSP never has to allow the STT host.

import { useCallback, useEffect, useRef, useState } from "react";

import { settingsStore } from "./settings";

export type DictationState = "idle" | "recording" | "transcribing";

export interface Dictation {
  state: DictationState;
  error: string | null;
  toggle: () => void;
}

/** Encode bytes to base64 without overflowing the call stack on large buffers. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function useDictation(onText: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => () => {
    generationRef.current++;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    busyRef.current = false;
  }, []);

  const start = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const generation = generationRef.current;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (generation === generationRef.current) {
        busyRef.current = false;
        setError(`Microphone unavailable: ${(e as Error).message}`);
      }
      return;
    }

    if (generation !== generationRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch (e) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      busyRef.current = false;
      setError(`Recording unavailable: ${(e as Error).message}`);
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      if (generation !== generationRef.current) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      void finishTranscription(blob);
    };

    const finishTranscription = async (blob: Blob): Promise<void> => {
      if (blob.size === 0) {
        busyRef.current = false;
        setState("idle");
        return;
      }
      setState("transcribing");
      try {
        const buffer = new Uint8Array(await blob.arrayBuffer());
        if (generation !== generationRef.current) return;
        const s = settingsStore.get();
        const res = await window.moss.stt.transcribe({
          audioBase64: bytesToBase64(buffer),
          mimeType: blob.type,
          baseUrl: (s.sttBaseUrl || s.baseUrl || "").trim(),
          apiKey: s.apiKey || undefined,
          model: s.sttModel || "whisper-1",
        });
        if (generation !== generationRef.current) return;
        if (res.error) setError(res.error);
        else if (res.text) onText(res.text);
      } catch (e) {
        if (generation === generationRef.current) setError((e as Error).message);
      } finally {
        if (generation === generationRef.current) {
          busyRef.current = false;
          setState("idle");
        }
      }
    };

    recorderRef.current = recorder;
    try {
      recorder.start();
      setState("recording");
    } catch (e) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorderRef.current = null;
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      busyRef.current = false;
      setError(`Recording unavailable: ${(e as Error).message}`);
    }
  }, [onText]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else if (state === "idle") void start();
  }, [state, start, stop]);

  return { state, error, toggle };
}
