import {
  getLoginStatus,
  createAudiotoolClient,
  type LoginStatus,
  type SyncedDocument,
} from "@audiotool/nexus";
import { recableOldCentroidToMixer, revertRecable, type RevertPayload } from "./recable";

const CLIENT_ID = import.meta.env.VITE_AUDIOTOOL_CLIENT_ID ?? "";
const REDIRECT_URL = import.meta.env.VITE_AUDIOTOOL_REDIRECT_URL ?? "http://127.0.0.1:5173/";
const SCOPE = import.meta.env.VITE_AUDIOTOOL_SCOPE ?? "project:write";

const TOOL_DESCRIPTION = `
**Recable centroid → mixer** migrates an old Centroid-based mix to the integrated mixer in one step.

**Channels** — Finds the centroid feeding the mixer (directly or via a device chain). Every cable into the centroid’s channel inputs becomes a new mixer channel. The centroid sum and any insert chain (e.g. compressor) are wired into the **master insert** (sum → new channel, chain → insert send/return).

**Per-channel** — Each new channel gets: fader (post gain), pan, mute, solo; for Centroid sources also pre-gain (−8 dB). EQ is mapped from the 3-band Centroid EQ to the 4-band mixer EQ (low/high shelf fixed; mid → low-mid or high-mid by frequency, gap 700–1600 Hz uses nearest band).

**Aux 1 & 2** — If the centroid aux is used, the tool creates a new mixer aux, moves the effect chain to its insert, and routes each new channel to it with the original send level. The centroid’s **global aux send gain** is copied to the mixer aux pre-gain.

**Submixers** — Cables from Kobolt, Minimixer or nested Centroid become a **mixer group** each: channels inside the group, same pan/pre-gain/eq/aux sends; device chains at the submixer output go to the group’s insert. Submixer auxes get new mixer auxes and routes.

**Automation** — Fader, pan, pre-gain, mute, solo, EQ and aux send automation are copied to the new mixer channels and aux routes (regions and events unchanged). Mid EQ automation maps to low-mid or high-mid; aux send automation → mixerAuxRoute gain; centroid aux send gain automation → mixer aux pre-gain.
`;

const TOOL_DESCRIPTION_NOT = `
**EQ sound** — The mixer’s 4-band EQ behaves differently; you may need to tweak after recabling.

**Undo** — Undo puts the mix back the way it was before recabling. If you changed the project in the meantime, a few cables might not come back; you’ll see a note in the log.`;

const TOOL_HOW_TO_USE = `
1. **Log in** with Audiotool, then open an old-style project (Centroid output → single mixer channel) in the studio and copy the project URL.
2. **Connect** — Paste URL, click Connect, wait for **Connected**.
3. **Recable** — Click **Recable centroid → mixer**. Changes sync live.
4. **Undo** — Click **Undo recable** to put the mix back as before. If you changed the project in between, a few cables might not be restored; the log will tell you.
5. Check the log for any warnings (e.g. skipped cables or automation).
`;

export async function createApp(): Promise<HTMLElement> {
  const container = document.createElement("div");
  container.className = "app";

  const descriptionCard = document.createElement("section");
  descriptionCard.className = "card tool-description";
  descriptionCard.innerHTML = `<h2>What this tool does</h2><div class="tool-description-body">${TOOL_DESCRIPTION.trim().replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>")}</div>`;
  container.appendChild(descriptionCard);

  const notCard = document.createElement("section");
  notCard.className = "card tool-description tool-description-not";
  notCard.innerHTML = `<h2>What this tool does NOT do</h2><div class="tool-description-body">${TOOL_DESCRIPTION_NOT.trim().replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>")}</div>`;
  container.appendChild(notCard);

  const howToCard = document.createElement("section");
  howToCard.className = "card tool-description";
  howToCard.innerHTML = `<h2>How to use</h2><div class="tool-description-body">${TOOL_HOW_TO_USE.trim().replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>")}</div>`;
  container.appendChild(howToCard);

  const title = document.createElement("h1");
  title.textContent = "Track Recabler";
  container.appendChild(title);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent =
    "Connect an old-style Audiotool project and recable the centroid’s channel inputs to new mixer channels.";
  container.appendChild(subtitle);

  if (!CLIENT_ID) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <p class="error">Missing <code>VITE_AUDIOTOOL_CLIENT_ID</code></p>
      <p class="status">Create an app at <a href="https://developer.audiotool.com/applications" target="_blank" rel="noopener">developer.audiotool.com/applications</a>, then add a <code>.env</code> file with:</p>
      <pre>VITE_AUDIOTOOL_CLIENT_ID=your_client_id</pre>
    `;
    container.appendChild(card);
    return container;
  }

  const loginStatus = await getLoginStatus({
    clientId: CLIENT_ID,
    redirectUrl: REDIRECT_URL,
    scope: SCOPE,
  });

  if (loginStatus.loggedIn) {
    renderLoggedIn(container, loginStatus);
  } else {
    renderLoggedOut(container, loginStatus);
  }

  return container;
}

function renderLoggedOut(
  container: HTMLElement,
  status: Extract<LoginStatus, { loggedIn: false }>
): void {
  const card = document.createElement("div");
  card.className = "card";
  const statusEl = document.createElement("p");
  statusEl.className = "status";
  statusEl.textContent =
    "Not logged in. Click Login to authorize this app with your Audiotool account.";
  card.appendChild(statusEl);
  if (status.error) {
    const errEl = document.createElement("p");
    errEl.className = "status error";
    errEl.textContent = status.error.message;
    card.appendChild(errEl);
  }
  const loginBtn = document.createElement("button");
  loginBtn.className = "btn-primary";
  loginBtn.textContent = "Login with Audiotool";
  loginBtn.onclick = () => status.login();
  card.appendChild(loginBtn);
  container.appendChild(card);
}

function renderLoggedIn(container: HTMLElement, status: LoginStatus & { loggedIn: true }): void {
  const card = document.createElement("div");
  card.className = "card";
  const userLine = document.createElement("p");
  userLine.className = "status connected";
  userLine.textContent = "Logged in. Loading…";
  status.getUserName().then((name) => {
    userLine.textContent =
      typeof name === "string" ? `Logged in as ${name}` : "Logged in";
  });
  card.appendChild(userLine);
  const logoutBtn = document.createElement("button");
  logoutBtn.className = "btn-secondary";
  logoutBtn.textContent = "Logout";
  logoutBtn.onclick = () => status.logout();
  card.appendChild(logoutBtn);
  container.appendChild(card);

  createAudiotoolClient({ authorization: status })
    .then((client) => {
      renderProjectConnect(container, client);
    })
    .catch((err) => {
      const errCard = document.createElement("div");
      errCard.className = "card";
      errCard.innerHTML = `<p class="error">Failed to create Audiotool client: ${err instanceof Error ? err.message : String(err)}</p>`;
      container.appendChild(errCard);
    });
}

function renderProjectConnect(
  container: HTMLElement,
  client: Awaited<ReturnType<typeof createAudiotoolClient>>
): void {
  const card = document.createElement("div");
  card.className = "card";
  const label = document.createElement("label");
  label.textContent = "Project URL (from beta.audiotool.com)";
  card.appendChild(label);
  const input = document.createElement("input");
  input.type = "url";
  input.placeholder = "https://beta.audiotool.com/…";
  card.appendChild(input);
  const statusEl = document.createElement("p");
  statusEl.className = "status";
  card.appendChild(statusEl);
  const connectBtn = document.createElement("button");
  connectBtn.className = "btn-primary";
  connectBtn.textContent = "Connect to project";
  connectBtn.onclick = async () => {
    const projectUrl = input.value.trim();
    if (!projectUrl) {
      statusEl.textContent = "Enter a project URL.";
      statusEl.className = "status error";
      return;
    }
    statusEl.textContent = "Connecting…";
    statusEl.className = "status";
    connectBtn.disabled = true;
    try {
      const doc = await client.createSyncedDocument({ project: projectUrl });
      renderDocumentUI(container, doc, client);
      card.remove();
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : "Connection failed.";
      statusEl.className = "status error";
      connectBtn.disabled = false;
    }
  };
  card.appendChild(connectBtn);
  container.appendChild(card);
}

function renderDocumentUI(
  container: HTMLElement,
  doc: SyncedDocument,
  client: Awaited<ReturnType<typeof createAudiotoolClient>>
): void {
  const card = document.createElement("div");
  card.className = "card";
  const statusEl = document.createElement("p");
  statusEl.className = "status connected";
  statusEl.textContent = "Connected. Syncing…";
  card.appendChild(statusEl);

  const logEl = document.createElement("div");
  logEl.className = "log";
  const addLog = (msg: string, type: "created" | "removed" | "info" = "info") => {
    const line = document.createElement("div");
    line.className = type;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  };

  doc.events.onCreate("mixerChannel", () => addLog("Mixer channel created", "created"));
  doc.events.onCreate("desktopAudioCable", () => addLog("Cable created", "created"));
  doc.events.onRemove("*", (entity) => {
    if (entity.entityType === "desktopAudioCable") addLog("Cable removed", "removed");
  });

  doc.connected.subscribe((connected: boolean) => {
    statusEl.textContent = connected
      ? "Connected"
      : "Disconnected (reconnecting…)";
    statusEl.className = connected ? "status connected" : "status error";
  });

  doc
    .start()
    .then(() => {
      statusEl.textContent = "Connected — recable old centroid below.";
      statusEl.className = "status connected";
    })
    .catch((err) => {
      statusEl.textContent = `Sync failed: ${err instanceof Error ? err.message : String(err)}`;
      statusEl.className = "status error";
    });

  const actions = document.createElement("div");
  actions.className = "actions";
  let lastRevertPayload: RevertPayload | null = null;
  const recableBtn = document.createElement("button");
  recableBtn.className = "btn-primary";
  recableBtn.textContent = "Recable centroid → mixer";
  recableBtn.onclick = async () => {
    addLog("Recabling…", "info");
    recableBtn.disabled = true;
    try {
      const result = await recableOldCentroidToMixer(doc);
      if (result.ok) {
        lastRevertPayload = result.revertPayload;
        undoBtn.disabled = false;
        addLog(
          `Done: ${result.cablesRecabled} cable(s) recabled to ${result.cablesRecabled} new mixer channel(s).`,
          "created"
        );
        if (result.warnings.length > 0) {
          addLog(`${result.warnings.length} cable(s) could not be created:`, "info");
          for (const warn of result.warnings) {
            addLog(`  • ${warn}`, "info");
          }
        }
      } else {
        addLog(result.error, "removed");
      }
    } catch (err) {
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`, "removed");
    } finally {
      recableBtn.disabled = false;
    }
  };
  actions.appendChild(recableBtn);
  const undoBtn = document.createElement("button");
  undoBtn.className = "btn-secondary";
  undoBtn.textContent = "Undo recable";
  undoBtn.disabled = true;
  undoBtn.onclick = async () => {
    if (!lastRevertPayload) return;
    addLog("Reverting recable…", "info");
    undoBtn.disabled = true;
    recableBtn.disabled = true;
    try {
      const result = await revertRecable(doc, lastRevertPayload!);
      if (result.ok) {
        lastRevertPayload = null;
        addLog("Reverted: recable changes undone.", "info");
        if (result.warnings.length > 0) {
          for (const w of result.warnings) addLog(w, "removed");
        }
      } else {
        addLog(`Revert failed: ${result.error}`, "removed");
        undoBtn.disabled = false;
      }
    } catch (err) {
      addLog(`Revert error: ${err instanceof Error ? err.message : String(err)}`, "removed");
      undoBtn.disabled = false;
    } finally {
      recableBtn.disabled = false;
    }
  };
  actions.appendChild(undoBtn);
  const resetBtn = document.createElement("button");
  resetBtn.className = "btn-secondary";
  resetBtn.textContent = "Connect to different project";
  resetBtn.onclick = () => {
    card.remove();
    renderProjectConnect(container, client);
  };
  actions.appendChild(resetBtn);

  card.appendChild(actions);
  card.appendChild(logEl);
  container.appendChild(card);
}
