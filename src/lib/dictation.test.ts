// @vitest-environment jsdom
//
// src/lib/dictation.test.ts
//
// useDictation drives a push-to-talk state machine over MediaRecorder and the
// main-process STT bridge. jsdom provides no MediaRecorder or mediaDevices, so
// both are faked minimally; the state transitions, the onText callback, and the
// error paths are the logic under test.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDictation } from "./dictation";

const transcribe = vi.fn();
const trackStop = vi.fn();
let getUserMedia: ReturnType<typeof vi.fn>;

// Minimal MediaRecorder: stop() fires one data chunk then the stop event, which
// is what the hook listens for to build the audio blob and transcribe it.
class FakeMediaRecorder {
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";
  start(): void {}
  stop(): void {
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: trackStop }] }));
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.assign(window, { moss: { stt: { transcribe } } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete (window as { moss?: unknown }).moss;
});

describe("useDictation", () => {
  it("starts in the idle state", () => {
    const { result } = renderHook(() => useDictation(vi.fn()));
    expect(result.current.state).toBe("idle");
  });

  it("transitions idle -> recording -> idle and reports the transcript", async () => {
    transcribe.mockResolvedValueOnce({ text: "hello world" });
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation(onText));

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("recording"));

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("idle"));

    expect(onText).toHaveBeenCalledWith("hello world");
    expect(trackStop).toHaveBeenCalled();
  });

  it("sets an error when the microphone is unavailable", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("denied"));
    const { result } = renderHook(() => useDictation(vi.fn()));

    act(() => result.current.toggle());

    await waitFor(() => expect(result.current.error).toBe("Microphone unavailable: denied"));
    expect(result.current.state).toBe("idle");
  });

  it("releases the microphone without transcribing when unmounted during recording", async () => {
    const { result, unmount } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("recording"));

    unmount();

    expect(trackStop).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("releases permission granted after unmount without starting recording", async () => {
    const stream = await getUserMedia();
    let grantPermission!: (value: MediaStream) => void;
    getUserMedia.mockReturnValueOnce(new Promise<MediaStream>((resolve) => { grantPermission = resolve; }));
    const start = vi.spyOn(FakeMediaRecorder.prototype, "start");
    const { result, unmount } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.toggle());
    unmount();

    await act(async () => grantPermission(stream));

    expect(trackStop).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("ignores duplicate starts while microphone permission is pending", async () => {
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => {
      result.current.toggle();
      result.current.toggle();
    });

    await waitFor(() => expect(result.current.state).toBe("recording"));
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it.each(["constructor", "start"])("releases the microphone after recorder %s failure", async (stage) => {
    if (stage === "constructor") {
      vi.stubGlobal("MediaRecorder", class {
        constructor() { throw new Error("unsupported recording"); }
      });
    } else {
      vi.spyOn(FakeMediaRecorder.prototype, "start").mockImplementationOnce(() => {
        throw new Error("unsupported recording");
      });
    }
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.toggle());

    await waitFor(() => expect(result.current.error).toBe("Recording unavailable: unsupported recording"));
    expect(result.current.state).toBe("idle");
    expect(trackStop).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("ignores a transcription result delivered after unmount", async () => {
    let finish!: (value: { text: string }) => void;
    transcribe.mockReturnValueOnce(new Promise<{ text: string }>((resolve) => { finish = resolve; }));
    const onText = vi.fn();
    const { result, unmount } = renderHook(() => useDictation(onText));
    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    act(() => result.current.toggle());
    await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    unmount();

    await act(async () => finish({ text: "late transcript" }));

    expect(onText).not.toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalledOnce();
  });

  it("surfaces a transcription error without calling onText", async () => {
    transcribe.mockResolvedValueOnce({ error: "model offline" });
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation(onText));

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("recording"));

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.error).toBe("model offline"));

    expect(onText).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });
});
