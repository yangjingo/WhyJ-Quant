/** Keep development windows separate from installed Windows shortcuts and their cached icons. */
export function desktopAppUserModelId(isPackaged: boolean, platform: string): string {
  const productionId = "io.github.yangjingo.whyj-quant";
  return platform === "win32" && !isPackaged ? `${productionId}.dev` : productionId;
}
