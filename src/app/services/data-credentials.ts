import { dataCredentialKey } from "../../runtime/data/data-readiness.ts";
import type { DataSource } from "../../types/config.ts";
import type { SettingsPort } from "../workbench/model.ts";
import { WorkbenchError } from "../workbench/errors.ts";

/** Remove only the chosen saved credential; the provider and environment remain untouched. */
export function removeDataCredential(port: SettingsPort, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkbenchError("INPUT_INVALID", "数据源凭据请求无效。");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "source" && key !== "revision") || typeof input.source !== "string"
    || !["tickflow", "tushare", "llmquant-data", "financial-datasets"].includes(input.source)
    || typeof input.revision !== "string" || !input.revision || input.revision.length > 160) throw new WorkbenchError("INPUT_INVALID", "数据源凭据请求无效。");
  const key = dataCredentialKey(input.source as DataSource)!;
  const settings = structuredClone(port.read());
  if (settings.revision !== input.revision) throw new WorkbenchError("ESTORAGECONFLICT", "设置已被其他窗口修改，请重新读取后再操作。", 409);
  if (!Object.hasOwn(settings.env, key)) return false;
  delete settings.env[key]; port.save(settings); return true;
}
