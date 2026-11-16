// Trusted transport shell, never an application capability. No Host token is received.
(() => {
  const frame = document.getElementById("report");
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
  let blobUrl, currentId;
  const send = (status, detail) => parent.postMessage({ type: "report-preview-status", id: currentId, status, detail }, location.origin);
  window.addEventListener("securitypolicyviolation", event => {
    if (currentId && event.effectiveDirective === "frame-src") send("blocked", "报告尝试跳转到预览边界以外，已阻止。可以重新打开报告。");
  });
  window.addEventListener("message", event => {
    if (event.source !== parent || event.origin !== location.origin) return;
    const value = event.data;
    if (!value || value.type !== "render-report" || typeof value.id !== "string" || value.id.length > 160
      || typeof value.html !== "string" || value.html.length > 8 * 1024 * 1024
      || typeof value.echarts !== "string" || value.echarts.length > 2 * 1024 * 1024) return;
    currentId = value.id;
    try {
      // Parse inside the shell's restrictive CSP. Parsing untrusted markup in the
      // application document can itself initiate subresource requests.
      const doc = new DOMParser().parseFromString(value.html, "text/html");
      for (const element of doc.querySelectorAll("base,link,meta[http-equiv],iframe,frame,object,embed,script[src]")) element.remove();
      const csp = doc.createElement("meta"); csp.httpEquiv = "Content-Security-Policy"; csp.content = policy;
      doc.head.prepend(csp);
      const charts = doc.createElement("script"); charts.textContent = value.echarts.replace(/<\/script/gi, "<\\/script"); csp.after(charts);
      const html = "<!doctype html>" + doc.documentElement.outerHTML;
      const next = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const previous = blobUrl; blobUrl = next;
      frame.onload = () => { if (frame.src === next) send("ready"); };
      frame.src = next;
      if (previous) URL.revokeObjectURL(previous);
    } catch { send("error", "报告无法在隔离视图中打开，原始下载仍可用。"); }
  });
  window.addEventListener("pagehide", () => { if (blobUrl) URL.revokeObjectURL(blobUrl); });
  parent.postMessage({ type: "report-preview-shell-ready" }, location.origin);
})();
