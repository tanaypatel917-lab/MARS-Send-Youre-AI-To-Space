const assert = require("node:assert/strict");
const { once } = require("node:events");
const { app, dialog } = require("electron");

let phase = "opening the main window";
const timeout = setTimeout(() => {
  console.error(`Timed out ${phase}`);
  app.exit(1);
}, 12_000);
async function verify(window) {
  const contents = window.webContents;
  const state = () =>
    contents.executeJavaScript("window.marsTeamChat['team.state']({})");
  await once(contents, "did-finish-load");
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(contents.getURL(), "mars-shell://app/index.html");
    assert.equal((await state()).ok, true);
    const gone = once(contents, "render-process-gone");
    const loaded = once(contents, "did-finish-load");
    phase = `waiting for crash ${attempt}`;
    if (attempt === 2) {
      dialog.showMessageBox = async () => ({ response: 1 });
      window.emit("unresponsive");
    } else {
      if (!contents.debugger.isAttached()) contents.debugger.attach();
      void contents.debugger.sendCommand("Page.crash").catch(() => {});
    }
    const [, details] = await gone;
    if (attempt !== 2) assert.equal(details.reason, "crashed");
    phase = `waiting for recovery after crash ${attempt}`;
    await loaded;
  }
  assert.equal(contents.getURL(), "mars-shell://app/recovery.html");
  assert.match(
    await contents.executeJavaScript("document.body.innerText"),
    /reopen MARS/i,
  );
  assert.equal(await contents.executeJavaScript("document.scripts.length"), 0);
  assert.deepEqual(await state(), { ok: false, code: "forbidden" });
}

app.once("browser-window-created", (_event, window) => {
  verify(window)
    .then(() => {
      clearTimeout(timeout);
      app.exit(0);
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
});
require("./main.cjs");
