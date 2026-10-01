// electron/backend/moss/tools/transcribe-tool.test.ts
//
// Unit tests for the transcribe_audio tool. The filesystem read and the network
// Whisper call are mocked, so these exercise the tool's own logic: argument
// validation, the missing-endpoint guard, workspace sandbox enforcement,
// extension -> MIME mapping, and result handling.

import { afterEach, describe, expect, it, vi } from "vitest";

// The workspace does not exist on disk, so the path guard skips its link check.
vi.mock("node:fs", () => ({ readFileSync: vi.fn(() => Buffer.from("AUDIO")), existsSync: vi.fn(() => false), realpathSync: { native: vi.fn((path: string) => path) } }));
vi.mock("../stt", () => ({ transcribeAudio: vi.fn(async () => "transcribed text") }));

import { readFileSync } from "node:fs";

import { transcribeAudio } from "../stt";
import { transcribeAudioTool } from "./transcribe-tool";
import type { ToolContext } from "./types";

const STT = { baseUrl: "http://localhost:1234/v1", apiKey: "key", model: "whisper-1" };

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return { workspaceRoot: "/work", signal: new AbortController().signal, stt: STT, ...overrides };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("transcribe_audio", () => {
  it("requires a non-empty path", async () => {
    expect(await transcribeAudioTool.execute({}, ctx())).toEqual({ ok: false, content: "path is required" });
    expect(await transcribeAudioTool.execute({ path: "   " }, ctx())).toEqual({
      ok: false,
      content: "path is required",
    });
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("errors when no speech-to-text endpoint is configured", async () => {
    const res = await transcribeAudioTool.execute({ path: "clip.wav" }, ctx({ stt: undefined }));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("No speech-to-text endpoint configured");
    expect(readFileSync).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("rejects paths that escape the workspace sandbox", async () => {
    const res = await transcribeAudioTool.execute({ path: "../secret.wav" }, ctx());
    expect(res.ok).toBe(false);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("maps the file extension to a MIME type and returns the transcript", async () => {
    const res = await transcribeAudioTool.execute({ path: "clip.flac" }, ctx());
    expect(res).toEqual({ ok: true, content: "transcribed text" });
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transcribeAudio).mock.calls[0][0]).toMatchObject({
      mimeType: "audio/flac",
      baseUrl: STT.baseUrl,
      apiKey: STT.apiKey,
      model: STT.model,
      audioBase64: Buffer.from("AUDIO").toString("base64"),
    });
  });

  it("defaults an unknown extension to audio/webm", async () => {
    await transcribeAudioTool.execute({ path: "clip.bin" }, ctx());
    expect(vi.mocked(transcribeAudio).mock.calls[0][0]).toMatchObject({ mimeType: "audio/webm" });
  });

  it("returns a placeholder when the transcript is empty", async () => {
    vi.mocked(transcribeAudio).mockResolvedValueOnce("");
    const res = await transcribeAudioTool.execute({ path: "clip.wav" }, ctx());
    expect(res).toEqual({ ok: true, content: "(no speech detected)" });
  });

  it("surfaces transcription errors", async () => {
    vi.mocked(transcribeAudio).mockRejectedValueOnce(new Error("upstream 500"));
    const res = await transcribeAudioTool.execute({ path: "clip.wav" }, ctx());
    expect(res).toEqual({ ok: false, content: "upstream 500" });
  });
});
