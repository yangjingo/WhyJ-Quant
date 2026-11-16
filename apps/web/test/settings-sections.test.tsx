import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Settings, type DialogPage } from "../src/components/Settings";
import { Footer } from "../src/components/Chrome";
import type { Preferences, SessionSnapshot } from "../src/client/contract";

Object.assign(globalThis, { __APP_VERSION__: "test-version" });

const preferences: Preferences = { model: "model-id", source: "none", portfolio: "Growth", availablePortfolios: ["Growth", "Value"], researchSource: "akshare", researchSources: [{ id: "akshare", label: "AKShare", requiresCredential: false, credentialConfigured: false }] };
const snapshot = { state: "running", identity: { workspaceId: "workspace", sessionId: "session", runId: "run" } } as SessionSnapshot;
function render(page: DialogPage, mode = "host", current: SessionSnapshot | null = snapshot) {
  return renderToStaticMarkup(<Settings page={page} mode={mode} preferences={preferences} setPage={() => {}} onClose={() => {}} onPreferences={async () => {}} snapshot={current} title="My session" onRename={async () => {}} clientSettings={{ fontSize: 15, sendKey: "enter" }} onClientSettings={() => {}} settingsSaved onStop={() => {}} canDelete onDelete={async () => {}} />);
}

test("settings sections are ordered, selected, and omit frontend command help", () => {
  const pages: DialogPage[] = ["reading", "session", "model", "source"];
  const labels = ["界面", "会话", "模型", "数据"];
  for (let i = 0; i < pages.length; i++) {
    const html = render(pages[i]!);
    const nav = html.match(/<nav[^>]*>(.*?)<\/nav>/s)?.[1] ?? "";
    expect([...nav.matchAll(/>([^<>]+)<\/button>/g)].map(match => match[1])).toEqual(labels);
    expect(nav).toContain(`aria-current="page">${labels[i]}</button>`);
    expect(html).not.toContain("命令帮助");
  }
});

test("data and session sections retain existing controls and honest availability", () => {
  const source = render("source");
  expect(source).toContain('aria-label="研究数据源"');
  expect(source).toContain('aria-label="投资组合"');
  expect(source).toContain("不代表真实持仓");
  expect(source).toContain("连接测试尚未在此界面开放");
  const session = render("session");
  expect(session).toContain("停止生成");
  expect(session).toContain('aria-label="会话名称"');
  expect(session).toContain("删除当前会话");
  expect(session).toContain("运行中的会话不能删除");
  expect(session).toContain('disabled=""');
});

test("version tells host, disconnected and demo states apart", () => {
  const reading = render("reading", "host");
  expect(reading).toContain("WhyJ Quant vtest-version");
  expect(reading.indexOf("WhyJ Quant vtest-version")).toBeGreaterThan(reading.indexOf("恢复界面默认值"));
  expect(render("reading", "host")).toContain("当前界面连接到工作区研究服务");
  expect(render("reading", "disconnected", null)).toContain("当前界面尚未连接研究服务");
  expect(render("reading", "demo")).toContain("数据、证据与报告均为合成示例");
});

test("footer retains model, source and observation group shortcuts", () => {
  const html = renderToStaticMarkup(<Footer preferences={preferences} mode="host" onOpen={() => {}} />);
  expect(html).toContain("model-id"); expect(html).toContain("研究源：AKShare"); expect(html).toContain("Growth");
});
