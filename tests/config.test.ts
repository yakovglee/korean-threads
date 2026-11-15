import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";

describe("loadConfig", () => {
  it('loadConfig: модели по умолчанию и переопределение', () => {
    expect(loadConfig({}).models.write).toBe('anthropic/claude-sonnet-5.5')
    expect(loadConfig({ MODEL_WRITE: 'x/y' }).models.write).toBe('x/y')
    expect(loadConfig({}).analyzerUrl).toBe('http://127.0.0.1:8000')
  })

  it("все пять моделей по умолчанию из Global Constraints", () => {
    expect(loadConfig({}).models).toEqual({
      write: "anthropic/claude-sonnet-5.5",
      light: "anthropic/claude-haiku-5.5",
      vision: "google/gemini-3.8-flash",
      verify: "google/gemini-3.8-flash",
      embed: "baai/bge-m3",
    });
  });

  it("publicFeed true по умолчанию и false при PUBLIC_FEED=off", () => {
    expect(loadConfig({}).publicFeed).toBe(true);
    expect(loadConfig({ PUBLIC_FEED: "off" }).publicFeed).toBe(false);
    // выключатель публичного доступа не должен молча оставаться включённым
    for (const v of ["false", "0", "no", "OFF", "of", "нет"]) expect(loadConfig({ PUBLIC_FEED: v }).publicFeed).toBe(false);
    for (const v of ["on", "ON", "true", "1", "yes"]) expect(loadConfig({ PUBLIC_FEED: v }).publicFeed).toBe(true);
  });

  it("tz по умолчанию Asia/Jayapura", () => {
    expect(loadConfig({}).tz).toBe("Asia/Jayapura");
  });

  it("examDate: null без EXAM_DATE, строка при 2027-02-14, null при значении не в формате YYYY-MM-DD", () => {
    expect(loadConfig({}).examDate).toBeNull();
    expect(loadConfig({ EXAM_DATE: "2027-02-14" }).examDate).toBe("2027-02-14");
    expect(loadConfig({ EXAM_DATE: "14.02.2027" }).examDate).toBeNull();
    expect(loadConfig({ EXAM_DATE: "2027-2-14" }).examDate).toBeNull();
    expect(loadConfig({ EXAM_DATE: "February 2027" }).examDate).toBeNull();
  });

  it('databaseUrl "" без DATABASE_URL', () => {
    expect(loadConfig({}).databaseUrl).toBe("");
  });

  it("krdictApiKey: undefined без KRDICT_API_KEY и при пустых пробелах, иначе значение без пробелов по краям", () => {
    expect(loadConfig({}).krdictApiKey).toBeUndefined();
    expect(loadConfig({ KRDICT_API_KEY: "   " }).krdictApiKey).toBeUndefined();
    expect(loadConfig({ KRDICT_API_KEY: " abc " }).krdictApiKey).toBe("abc");
  });
});
