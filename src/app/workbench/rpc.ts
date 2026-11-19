import type { WorkbenchClient } from "../../types/workbench.ts";
import { WorkbenchError } from "./errors.ts";
import { thesisRequest } from "../services/thesis-review.ts";
import { thesisSourcesRequest, thesisSourcesReadRequest } from "../services/thesis-sources.ts";
import { thesisTspRequest } from "../services/thesis-tsp.ts";
import { artifactRequest, deleteSessionRequest, nextRunRequest, preferencesRequest, renameSessionRequest, requestString, reviewRequest, runIdentity, runRevisionRequest, saveRequest, submitRequest } from "../services/requests.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkbenchError("INPUT_INVALID", "请求参数无效。");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 160) {
  if (typeof value !== "string" || value.length > max) throw new WorkbenchError("INPUT_INVALID", "请求参数无效。");
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new WorkbenchError("INPUT_INVALID", "请求包含未支持的字段。");
}

/** Explicit dispatch: browser input cannot choose an object property or call arbitrary service methods. */
export async function dispatchWorkbench(client: WorkbenchClient, payload: unknown) {
  const request = object(payload); keys(request, ["method", "args"]);
  const method = string(request.method), args = request.args;
  if (!Array.isArray(args)) throw new WorkbenchError("INPUT_INVALID", "请求参数无效。");
  const count = (length: number) => { if (args.length !== length) throw new WorkbenchError("INPUT_INVALID", "请求参数数量无效。"); };
  switch (method) {
    case "identity": count(0); return client.identity();
    case "workspaces": count(0); return client.workspaces();
    case "preferences": count(0); return client.preferences();
    case "startObservationJob": count(1); {
      if (!client.startObservationJob) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持行情采集。", 503);
      return client.startObservationJob(args[0] as Parameters<NonNullable<WorkbenchClient["startObservationJob"]>>[0]);
    }
    case "readObservationJob": count(1); {
      if (!client.readObservationJob) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持行情采集。", 503);
      return client.readObservationJob(requestString(args[0]));
    }
    case "cancelObservationJob": count(1); {
      if (!client.cancelObservationJob) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持行情采集。", 503);
      return client.cancelObservationJob(requestString(args[0]));
    }
    case "readObservationIndicators": count(1); {
      if (!client.readObservationIndicators) throw new WorkbenchError("METHOD_NOT_FOUND", "当前服务不支持指标预览。", 404);
      return client.readObservationIndicators(args[0] as Parameters<NonNullable<WorkbenchClient["readObservationIndicators"]>>[0]);
    }
    case "readObservationExchangeIndicators": count(1); {
      if (!client.readObservationExchangeIndicators) throw new WorkbenchError("METHOD_NOT_FOUND", "当前服务不支持交易信号预览。", 404);
      return client.readObservationExchangeIndicators(args[0] as Parameters<NonNullable<WorkbenchClient["readObservationExchangeIndicators"]>>[0]);
    }
    case "startDataDraft": count(0); {
      if (!client.startDataDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持数据源草稿。");
      return client.startDataDraft();
    }
    case "editDataDraft": count(1); {
      if (!client.editDataDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持数据源草稿。");
      return client.editDataDraft(args[0] as Parameters<NonNullable<WorkbenchClient["editDataDraft"]>>[0]);
    }
    case "verifyDataDraft": count(1); {
      if (!client.verifyDataDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持数据源草稿。");
      return client.verifyDataDraft(requestString(args[0]));
    }
    case "cancelDataDraft": count(1); {
      if (!client.cancelDataDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持数据源草稿。");
      return client.cancelDataDraft(requestString(args[0]));
    }
    case "saveDataDraft": count(1); {
      if (!client.saveDataDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持数据源草稿。");
      return client.saveDataDraft(args[0] as Parameters<NonNullable<WorkbenchClient["saveDataDraft"]>>[0]);
    }
    case "closeDataDraft": count(1); {
      if (!client.closeDataDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持数据源草稿。");
      return client.closeDataDraft(requestString(args[0]));
    }
    case "removeDataCredential": count(1); {
      if (!client.removeDataCredential) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持移除数据源凭据。");
      return client.removeDataCredential(args[0] as Parameters<NonNullable<WorkbenchClient["removeDataCredential"]>>[0]);
    }
    case "startModelDraft": count(0); {
      if (!client.startModelDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持模型草稿。");
      return client.startModelDraft();
    }
    case "editModelDraft": count(1); {
      if (!client.editModelDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持模型草稿。");
      return client.editModelDraft(args[0] as Parameters<NonNullable<WorkbenchClient["editModelDraft"]>>[0]);
    }
    case "verifyModelDraft": count(1); {
      if (!client.verifyModelDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持模型草稿。");
      return client.verifyModelDraft(requestString(args[0]));
    }
    case "cancelModelDraft": count(1); {
      if (!client.cancelModelDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持模型草稿。");
      return client.cancelModelDraft(requestString(args[0]));
    }
    case "saveModelDraft": count(1); {
      if (!client.saveModelDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持模型草稿。");
      return client.saveModelDraft(args[0] as Parameters<NonNullable<WorkbenchClient["saveModelDraft"]>>[0]);
    }
    case "closeModelDraft": count(1); {
      if (!client.closeModelDraft) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持模型草稿。");
      return client.closeModelDraft(requestString(args[0]));
    }
    case "removeModelCredential": count(1); {
      if (!client.removeModelCredential) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持移除模型凭据。");
      return client.removeModelCredential(args[0] as Parameters<NonNullable<WorkbenchClient["removeModelCredential"]>>[0]);
    }
    case "market": count(0); return client.market();
    case "refreshMarket": count(1); {
      if (typeof args[0] !== "boolean") throw new WorkbenchError("INPUT_INVALID", "重试参数无效。");
      if (!client.refreshMarket) throw new WorkbenchError("UNAVAILABLE", "此连接不支持行情刷新。");
      return client.refreshMarket(args[0]);
    }
    case "createSession": count(0); return client.createSession();
    case "session": count(1); return client.session(requestString(args[0]));
    case "transcript": count(1); return client.transcript(requestString(args[0]));
    case "output": count(1); return client.output(requestString(args[0]));
    case "cancel": count(1); return client.cancel(runIdentity(args[0]));
    case "acknowledgeInterruption": count(1); {
      if (!client.acknowledgeInterruption) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持恢复确认。");
      return client.acknowledgeInterruption(runRevisionRequest(args[0]));
    }
    case "renameSession": count(1); return client.renameSession(renameSessionRequest(args[0]));
    case "references": count(2); return client.references(requestString(args[0]), requestString(args[1], 1000, true));
    case "submit": {
      count(1); return client.submit(submitRequest(args[0]));
    }
    case "continue": {
      count(1); const input = nextRunRequest(args[0], "continue");
      if (!client.continue) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持继续操作。");
      return client.continue(input);
    }
    case "followup": {
      count(1); const input = nextRunRequest(args[0], "followup");
      if (!client.followup) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持追问操作。");
      return client.followup(input);
    }
    case "establishThesis": {
      count(1); const input = thesisRequest("baseline", args[0]);
      if (!client.establishThesis) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持设立假设基线。");
      return client.establishThesis(input);
    }
    case "saveThesisReview": {
      count(1); const input = thesisRequest("review", args[0]);
      if (!client.saveThesisReview) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持事件假设复核。");
      return client.saveThesisReview(input);
    }
    case "collectThesisSources": {
      count(1); const input = thesisSourcesRequest(args[0]);
      if (!client.collectThesisSources) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持来源核对。");
      return client.collectThesisSources(input);
    }
    case "readThesisSources": {
      count(1); const input = thesisSourcesReadRequest(args[0]);
      if (!client.readThesisSources) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持固定核对来源读取。");
      return client.readThesisSources(input);
    }
    case "collectThesisTsp": {
      count(1); const input = thesisTspRequest(args[0]);
      if (!client.collectThesisTsp) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持 TSP 观察采集。");
      return client.collectThesisTsp(input);
    }
    case "readThesisTsp": {
      count(1); const input = artifactRequest(args[0]);
      if (!client.readThesisTsp) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持 TSP 观察读取。");
      return client.readThesisTsp(input);
    }
    case "readThesis": {
      count(1); const input = artifactRequest(args[0]);
      if (!client.readThesis) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持复核记录读取。");
      return client.readThesis(input);
    }
    case "save": {
      count(1); const input = saveRequest(args[0]);
      if (!client.save) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持报告保存。");
      return client.save(input);
    }
    case "reload": {
      count(1); const input = artifactRequest(args[0]);
      if (!client.reload) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持固定报告重开。");
      return client.reload(input);
    }
    case "review": {
      count(1); const input = reviewRequest(args[0]);
      if (!client.review) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持独立复核。");
      return client.review(input);
    }
    case "deleteSession": {
      count(1); const input = deleteSessionRequest(args[0]);
      if (!client.deleteSession) throw new WorkbenchError("UNAVAILABLE", "当前服务不支持会话删除。");
      return client.deleteSession(input);
    }
    case "updatePreferences": {
      count(1); return client.updatePreferences(preferencesRequest(args[0]));
    }
    default: throw new WorkbenchError("METHOD_NOT_FOUND", "此连接不支持该操作。", 404);
  }
}
