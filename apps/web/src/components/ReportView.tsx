import { useEffect, useRef, useState } from "react";
import type { ArtifactRequest, ArtifactSummary, OriginalReport, WorkbenchClient } from "../client/contract";

/** The original is kept separately from the transformed, network-restricted preview. */
export function ReportView({ client, request, artifact, onClose }: {
  client: WorkbenchClient; request: ArtifactRequest; artifact: ArtifactSummary; onClose(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [report, setReport] = useState<OriginalReport | null>(null);
  const [charts, setCharts] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("正在读取并核验原始报告…");
  const [retry, setRetry] = useState(0);
  const [messageId] = useState(() => crypto.randomUUID());
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    setReport(null); setCharts(""); setError(""); setPreview("正在读取并核验原始报告…");
    if (!client.readReport) { setError("当前连接不支持原始报告读取，请连接支持该能力的 Host。"); return; }
    void client.readReport(request).then(value => {
      if (!active) return;
      setReport(value); setPreview(value.bytes ? "正在准备隔离交互视图…" : "此版本经过校验，但原始 HTML 内容为空。");
      if (value.bytes) void import("echarts/dist/echarts.min.js?raw").then(module => { if (active) setCharts(module.default); }, () => {
        if (active) setError("本地图表资源无法加载，仍可下载已核验的原始报告。");
      });
    }, failure => { if (active) setError(failure instanceof Error ? failure.message : "报告读取失败，原记录已保留。"); });
    return () => { active = false; };
  }, [client, request.workspaceId, request.sessionId, request.artifactId, request.sha256, retry]);
  useEffect(() => {
    const timeout = report?.bytes && charts ? setTimeout(() => {
      setError("隔离预览加载超时。可重新读取，或下载已核验的原始报告。");
    }, 15_000) : undefined;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== location.origin || event.data?.type !== "report-preview-status" || event.data.id !== messageId) return;
      if (["ready", "error", "blocked"].includes(event.data.status)) clearTimeout(timeout);
      if (event.data.status === "ready") setPreview("隔离交互预览 · 外部网络、弹窗和导航已限制");
      else if (["error", "blocked"].includes(event.data.status)) setError(typeof event.data.detail === "string" ? event.data.detail.slice(0, 500) : "报告预览不可用。");
    };
    window.addEventListener("message", receive); return () => { clearTimeout(timeout); window.removeEventListener("message", receive); };
  }, [messageId, report, charts, retry]);
  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report.html], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${artifact.id}-${artifact.sha256.slice(0, 12)}.html`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="report-view" aria-label="原始研究报告">
    <header className="report-view-header"><div><p className="eyebrow">固定报告 · v{artifact.version}</p><h2 ref={heading} tabIndex={-1}>{artifact.title}</h2></div>
      <div className="report-actions"><button className="action" disabled={!report} onClick={download}>下载原始 HTML</button><button className="action" onClick={onClose}>返回研究工作区</button></div></header>
    <p className="supporting report-preview-note">预览使用本地图表资源并限制外部访问；原始下载保留保存时的字节、脚本与外部引用。下载后打开原文件可能访问网络。</p>
    <details className="report-digests"><summary>版本与内容校验</summary><dl><dt>报告版本</dt><dd><code>{artifact.sha256}</code></dd><dt>HTML SHA-256</dt><dd><code>{report?.htmlSha256 ?? "核验中"}</code></dd><dt>原始大小</dt><dd>{report ? `${report.bytes.toLocaleString()} bytes` : "核验中"}</dd></dl></details>
    {error && <div className="connection-error" role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>重新读取</button></div>}
    <p className="report-preview-status" role="status">{error ? "预览未完成；原会话、草稿和研究运行保留。" : preview}</p>
    {report && report.bytes > 0 && charts && <iframe key={retry} ref={frame} className="report-frame" title="隔离交互报告" src="./assets/report-shell.html" referrerPolicy="no-referrer"
      onLoad={() => frame.current?.contentWindow?.postMessage({ type: "render-report", id: messageId, html: report.html, echarts: charts }, location.origin)} />}
    {report?.bytes === 0 && <div className="empty-state"><h3>报告内容为空</h3><p>这是已保存的空文件，不是新的报告或读取错误。</p></div>}
  </section>;
}
