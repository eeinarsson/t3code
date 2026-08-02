import { describe, expect, it } from "vite-plus/test";

import { resolveEmptyEditorMessage } from "./OpenInPicker";

describe("resolveEmptyEditorMessage", () => {
  it("does not report incomplete discovery as no installed editors", () => {
    expect(resolveEmptyEditorMessage(false)).toBe("Couldn’t check for installed editors");
  });

  it("treats missing discovery metadata from older servers as unknown", () => {
    expect(resolveEmptyEditorMessage(undefined)).toBe("Couldn’t check for installed editors");
  });

  it("reports no installed editors after complete empty discovery", () => {
    expect(resolveEmptyEditorMessage(true)).toBe("No installed editors found");
  });
});
