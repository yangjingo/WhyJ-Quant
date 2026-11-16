export interface ClientSettings { fontSize: 13 | 15 | 16 | 18; sendKey: "enter" | "ctrl-enter" }
const key = "whyj:client-settings:1";
export const defaultClientSettings: ClientSettings = { fontSize: 15, sendKey: "enter" };

/** Presentation preferences only: no conversation text, execution state, or secrets. */
export function readClientSettings(): ClientSettings {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return { ...defaultClientSettings };
    const candidate = value as Partial<ClientSettings>;
    return { fontSize: [13, 15, 16, 18].includes(candidate.fontSize as number) ? candidate.fontSize! : 15,
      sendKey: candidate.sendKey === "ctrl-enter" ? "ctrl-enter" : "enter" };
  } catch { return { ...defaultClientSettings }; }
}
export function writeClientSettings(value: ClientSettings): boolean {
  try { window.localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
