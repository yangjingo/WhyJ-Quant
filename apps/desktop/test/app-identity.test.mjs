import { test } from "node:test";
import { strict as assert } from "node:assert";
import { desktopAppUserModelId } from "../src/app-identity.mts";

const production = "io.github.yangjingo.whyj-quant";
test("Windows development identity does not associate with the installed shortcut", () => {
  assert.equal(desktopAppUserModelId(false, "win32"), `${production}.dev`);
  assert.equal(desktopAppUserModelId(true, "win32"), production);
});
test("non-Windows development and packaged identities retain existing behavior", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.equal(desktopAppUserModelId(false, platform), production);
    assert.equal(desktopAppUserModelId(true, platform), production);
  }
});
