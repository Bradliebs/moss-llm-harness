// src/lib/attachments.test.ts
//
// Unit tests for the pure attachment helpers (node environment).

import { describe, expect, it } from "vitest";

import { DOCX_MEDIA_TYPE, extractDocxText, imageAttachmentError, imageMediaType, isDocxFile, isLikelyVisionModel, isPdfFile, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, textAttachmentError, textLanguageForFile } from "./attachments";

describe("Word attachments", () => {
  it("recognizes DOCX by extension or MIME type without accepting legacy DOC", () => {
    expect(isDocxFile({ name: "report.DOCX", type: "" })).toBe(true);
    expect(isDocxFile({ name: "report", type: DOCX_MEDIA_TYPE })).toBe(true);
    expect(isDocxFile({ name: "report.doc", type: "application/msword" })).toBe(false);
  });

  it("extracts paragraphs from a real DOCX archive using the browser parser", async () => {
    const encoded = "UEsDBAoAAAAAAJCMNl0AAAAAAAAAAAAAAAAFAAAAd29yZC9QSwMECgAAAAgAAAAhXN78bRiZAAAA7AAAABEAAAB3b3JkL2RvY3VtZW50LnhtbG2PTQoCMQxGr1J6gMnowsUwP4dw4Tq2dTowbUoaHb297YAI4uaF8PjykX56hlU9HOeF4qAPTaunsd86S+YeXBRVdMzdNmgvkjqAbLwLmBtKLhZ3Iw4oZeUZNmKbmIzLeYlzWOHYticIuERdT17JvupMFVwh46VEFIqg8XubuCw9VFPJO9Nv6OwMRasSMs6Myf8JwKcOvq+Mb1BLAQIUAAoAAAAAAJCMNl0AAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAAAAAAAB3b3JkL1BLAQIUAAoAAAAIAAAAIVze/G0YmQAAAOwAAAARAAAAAAAAAAAAAAAAACMAAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAgACAHIAAADrAAAAAAA=";
    const data = Uint8Array.from(Buffer.from(encoded, "base64")).buffer;
    await expect(extractDocxText(data)).resolves.toBe("Word attachment test\n\nSecond paragraph\n\n");
  });

  it("rejects malformed DOCX data", async () => {
    await expect(extractDocxText(new ArrayBuffer(8))).rejects.toThrow();
  });
});

describe("imageMediaType", () => {
  it("resolves absent and generic MIME metadata for known extensions", () => {
    expect(imageMediaType({ name: "photo.JPG", type: "" })).toBe("image/jpeg");
    expect(imageMediaType({ name: "photo.png", type: "application/octet-stream" })).toBe("image/png");
  });

  it("does not override explicit non-image MIME metadata or guess unknown extensions", () => {
    expect(imageMediaType({ name: "report.png", type: "application/pdf" })).toBeNull();
    expect(imageMediaType({ name: "file.unknown", type: "" })).toBeNull();
    expect(imageMediaType({ name: "file.constructor", type: "" })).toBeNull();
  });
});

describe("imageAttachmentError", () => {
  it("accepts a known image extension when the MIME type is missing", () => {
    expect(imageAttachmentError({ type: "", size: 1024, name: "photo.PNG" })).toBeNull();
  });

  it("accepts an in-bounds image", () => {
    expect(imageAttachmentError({ type: "image/png", size: 1024, name: "a.png" })).toBeNull();
  });

  it("rejects a non-image file", () => {
    expect(imageAttachmentError({ type: "application/pdf", size: 10, name: "doc.pdf" })).toBe(
      "doc.pdf: not an image",
    );
  });

  it("rejects an image over the size cap", () => {
    expect(
      imageAttachmentError({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1, name: "big.jpg" }),
    ).toBe("big.jpg: image is larger than 10 MB");
  });
});

describe("textAttachmentError", () => {
  it("accepts an in-bounds text file", () => {
    expect(textAttachmentError({ size: 1024, name: "a.txt" })).toBeNull();
  });

  it("rejects a text file over the size cap", () => {
    expect(textAttachmentError({ size: MAX_TEXT_BYTES + 1, name: "huge.md" })).toBe(
      "huge.md: text file is larger than 256 KB",
    );
  });
});

describe("isLikelyVisionModel", () => {
  it("recognizes common vision-capable models", () => {
    for (const m of ["gpt-4o", "claude-3-5-sonnet", "llama3.2-vision", "gemini-1.5-pro"]) {
      expect(isLikelyVisionModel(m)).toBe(true);
    }
  });

  it("does not flag text-only models", () => {
    for (const m of ["gpt-3.5-turbo", "llama3.1", "mistral-7b"]) {
      expect(isLikelyVisionModel(m)).toBe(false);
    }
  });
});

describe("textLanguageForFile", () => {
  it("maps known extensions to a fence language hint", () => {
    expect(textLanguageForFile({ type: "", name: "notes.MD" })).toBe("markdown");
    expect(textLanguageForFile({ type: "", name: "a.py" })).toBe("python");
    expect(textLanguageForFile({ type: "", name: "data.json" })).toBe("json");
    expect(textLanguageForFile({ type: "", name: "notes.txt" })).toBe("");
  });

  it("defaults text/* MIME files to a plain fence", () => {
    expect(textLanguageForFile({ type: "text/plain", name: "no-ext" })).toBe("");
  });

  it("returns null for unsupported binary types", () => {
    expect(textLanguageForFile({ type: "application/pdf", name: "doc.pdf" })).toBeNull();
    expect(textLanguageForFile({ type: "image/png", name: "p.png" })).toBeNull();
  });
});

describe("isPdfFile", () => {
  it("recognizes PDFs by MIME type or extension", () => {
    expect(isPdfFile({ type: "application/pdf", name: "document" })).toBe(true);
    expect(isPdfFile({ type: "", name: "document.PDF" })).toBe(true);
    expect(isPdfFile({ type: "text/plain", name: "notes.txt" })).toBe(false);
  });
});
