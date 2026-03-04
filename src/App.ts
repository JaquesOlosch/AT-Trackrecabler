import {
  getLoginStatus,
  createAudiotoolClient,
  type LoginStatus,
  type SyncedDocument,
} from "@audiotool/nexus";
import { recableOldCentroidToMixer, revertRecable, type RevertPayload } from "./recable";

/**
 * Application UI: single-page web app for the Track Recabler tool.
 *
 * This module builds the entire UI imperatively using DOM APIs (no framework).
 * Layout: a sticky topbar (brand + login or username/logout) and a main content area below.
 *
 * Flow:
 * 1. **Logged out** — Topbar shows Login. Main area shows a short prompt to log in.
 * 2. **Logged in** — Topbar shows username and Logout. Main area shows intro text, project
 *    browser (list + search), URL field, and "Create copy & connect". "How to use" is at the bottom.
 * 3. **Document UI** — After connecting to a project copy: Recable / Undo / "Connect to different
 *    project" and a summary log. "How to use" stays at the bottom.
 *
 * Modals provide "What this tool does" and project rename. All API errors are surfaced via status text.
 */

const STUDIO_BASE = "https://beta.audiotool.com/studio";

/** Project list item shape (from listProjects API; we use name, displayName, coverUrl, snapshotUrl). */
type ProjectListItem = { name: string; displayName: string; coverUrl?: string; snapshotUrl?: string };

/** Normalize project name to id: "projects/foo" -> "foo". */
function projectIdFromName(name: string): string {
  return name.startsWith("projects/") ? name.slice("projects/".length) : name;
}

/** Move the "How to use" card to the end of the main content container (so it stays at bottom). */
function appendHowToToBottom(container: HTMLElement): void {
  const howTo = container.querySelector(".how-to-card");
  if (howTo) container.appendChild(howTo);
}

/** Extract the project ID from an Audiotool studio URL. Supports both query parameter format (?project=id) and path format (/studio/id). */
function getProjectIdFromUrl(projectUrl: string): string | null {
  try {
    const u = new URL(projectUrl);
    const fromQuery = u.searchParams.get("project");
    if (fromQuery) return fromQuery.trim() || null;
    const pathMatch = /\/studio\/([^/?#]+)/.exec(u.pathname);
    return pathMatch ? pathMatch[1].trim() : null;
  } catch {
    return null;
  }
}

/** Minimal markdown-to-HTML: convert **bold** to <strong>, {{highlight}} to <span class="highlight">, and newlines to <br>. */
function mdToHtml(text: string): string {
  return text
    .trim()
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\{\{(.*?)\}\}/g, '<span class="highlight">$1</span>')
    .replace(/\n/g, "<br>");
}

/** Extract a human-readable error message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const CLIENT_ID = import.meta.env.VITE_AUDIOTOOL_CLIENT_ID ?? "";
const REDIRECT_URL = import.meta.env.VITE_AUDIOTOOL_REDIRECT_URL ?? "http://127.0.0.1:5173/";
const SCOPE = import.meta.env.VITE_AUDIOTOOL_SCOPE ?? "project:write";

/** Remove OAuth callback params from the URL so a refresh or retry doesn't see stale code/state. */
function cleanOAuthParamsFromUrl(): void {
  const url = new URL(window.location.href);
  if (
    !url.searchParams.has("code") &&
    !url.searchParams.has("state") &&
    !url.searchParams.has("error")
  )
    return;
  url.searchParams.delete("code");
  url.searchParams.delete("scope");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  const cleanHref = url.origin + url.pathname + (url.hash || "");
  window.history.replaceState({}, document.title, cleanHref);
}

const TOOL_DESCRIPTION = `
**Recable** is a simple tool that helps you migrate your classic Audiotool projects (using Centroid, Kobolt, Minimixer, or Merger) to the new integrated mixer. It works entirely on a **copy** of your project, so your original work is always safe.

**How it works** — The tool scans your project to find the last mixer in the signal chain. It then rebuilds your entire mix in the new integrated mixer: every input becomes a proper channel, submixers are converted into nested groups, and your aux effects are automatically routed to new aux strips. Even your master chain effects are preserved and wired into the master insert.

**Channels** — Every cable feeding your old mixer is turned into a **new mixer channel**. We copy over all your settings: fader levels, panning, mute/solo states, and even map the old 3-band EQ to the new 4-band EQ. If you used a Centroid, we also preserve the pre-gain settings.

**Groups & Hierarchy** — Your mix structure is preserved perfectly. The main mixer becomes a top-level group, and any submixers feeding it become subgroups. If you had complex routing (like a Kobolt feeding a Centroid), that hierarchy is kept intact with nested groups.

**Mergers** — If your project uses an **Audio Merger** as the final output (or anywhere in the main chain), we handle that too! It becomes a merger group, with all its inputs organized as direct channels or subgroups. Note that the specific "triangle blend" settings of the merger can't be transferred, so those channels will start at default levels.

**Aux Effects** — Used aux sends on your Centroids or Minimixers? We've got you covered. The tool creates corresponding **mixer aux strips**, reconnects your effect chains, and sets up all the send levels exactly as they were. Each submixer gets its own dedicated aux strips, keeping your signal flow clean and correct.

**Automation** — We don't just move the static settings; we copy your automation too. Fader moves, pan sweeps, mute automation, and EQ changes are all transferred to the new mixer channels.
`;

const TOOL_DESCRIPTION_NOT = `
**EQ Sound** — While we map the settings as closely as possible, the new 4-band EQ sounds different from the old 3-band EQ. You might need to fine-tune your mix after recabling.

**Perfect Undo** — The "Undo" button reverts the copy to its state before recabling. However, if you make manual edits to the project *after* recabling but *before* clicking undo, some connections might not be perfectly restored. The log will let you know if anything was missed.`;

const TOOL_HOW_TO_USE = `
1. **Pick a project** — Use the project browser to find your classic project, or paste a project URL directly into the URL field.
2. **Connect** — Click **Create copy & connect**. We'll create a fresh copy and open it in a new window. {{If nothing opens}}, allow popups for this site (your browser may be blocking them).
3. **Recable** — Once connected, just click **Recable**. Watch as your entire mixer setup is instantly rebuilt in the new integrated mixer.
4. **Undo** — Not happy with the result? Click **Undo recable** to revert the changes and try again.
`;

const TOOL_DISCLAIMER =
  "This tool may not work on every project—especially uncommon or heavily nested setups. We don't guarantee it will work in all cases. We always work on a copy of your project and do our best to migrate your mix safely.";

/** Create the disclaimer element shown above "How to use". */
function createDisclaimerElement(): HTMLElement {
  const el = document.createElement("p");
  el.className = "disclaimer";
  el.textContent = TOOL_DISCLAIMER;
  return el;
}

/** Open an accessible modal dialog showing the tool description and limitations. The modal traps focus, closes on Escape/overlay-click, and restores body scroll on close. */
function openWhatThisToolDoesModal(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "modal-title");

  const dialog = document.createElement("div");
  dialog.className = "modal-dialog";
  const doesHtml = mdToHtml(TOOL_DESCRIPTION);
  const notHtml = mdToHtml(TOOL_DESCRIPTION_NOT);
  dialog.innerHTML = `
    <div class="modal-header">
      <h2 id="modal-title">What this tool does</h2>
      <button type="button" class="modal-close" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
      <section class="modal-section">
        <div class="tool-description-body">${doesHtml}</div>
      </section>
      <section class="modal-section modal-section-not">
        <h3>What this tool does NOT do</h3>
        <div class="tool-description-body">${notHtml}</div>
      </section>
    </div>
  `;

  const close = (): void => {
    overlay.remove();
    document.body.style.overflow = "";
  };

  dialog.querySelector(".modal-close")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  const closeBtn = dialog.querySelector<HTMLButtonElement>(".modal-close");
  closeBtn?.focus();
}

/** Open a modal to rename a project. Calls updateProject on save and invokes onSuccess with the new displayName. */
function openRenameProjectModal(
  project: ProjectListItem,
  client: Awaited<ReturnType<typeof createAudiotoolClient>>,
  onSuccess: (newDisplayName: string) => void
): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "rename-modal-title");

  const projectName = project.name.startsWith("projects/") ? project.name : `projects/${project.name}`;
  const currentName = project.displayName || "Untitled";

  const dialog = document.createElement("div");
  dialog.className = "modal-dialog";
  dialog.innerHTML = `
    <div class="modal-header">
      <h2 id="rename-modal-title">Rename project</h2>
      <button type="button" class="modal-close" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
      <label for="rename-input" style="display:block;margin-bottom:0.5rem;color:var(--text)">Project name</label>
      <input type="text" id="rename-input" value="${currentName.replace(/"/g, "&quot;")}" style="width:100%;padding:0.5rem;font-size:0.9rem;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text)">
      <p class="status" id="rename-status" style="margin-top:0.5rem;margin-bottom:0"></p>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem">
        <button type="button" class="btn-secondary" id="rename-cancel">Cancel</button>
        <button type="button" class="btn-primary" id="rename-save">Save</button>
      </div>
    </div>
  `;

  const close = (): void => {
    overlay.remove();
    document.body.style.overflow = "";
  };

  const input = dialog.querySelector<HTMLInputElement>("#rename-input")!;
  const statusEl = dialog.querySelector<HTMLParagraphElement>("#rename-status")!;
  const saveBtn = dialog.querySelector<HTMLButtonElement>("#rename-save")!;

  const save = async (): Promise<void> => {
    const newName = input.value.trim();
    if (!newName) {
      statusEl.textContent = "Please enter a name.";
      statusEl.className = "status error";
      return;
    }
    saveBtn.disabled = true;
    statusEl.textContent = "Saving…";
    statusEl.className = "status";
    const res = await client.api.projectService.updateProject({
      project: { name: projectName, displayName: newName },
      updateMask: { paths: ["display_name"] },
    });
    if (res instanceof Error) {
      statusEl.textContent = res.message;
      statusEl.className = "status error";
      saveBtn.disabled = false;
      return;
    }
    onSuccess(newName);
    close();
  };

  dialog.querySelector(".modal-close")?.addEventListener("click", close);
  dialog.querySelector("#rename-cancel")?.addEventListener("click", close);
  saveBtn.addEventListener("click", () => void save());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void save();
    if (e.key === "Escape") close();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  input.focus();
  input.select();
}

/** Build and return the root app element. Creates a topbar for login and the main content area below. */
export async function createApp(): Promise<HTMLElement> {
  const wrapper = document.createElement("div");

  const topbar = document.createElement("header");
  topbar.className = "topbar";
  const brand = document.createElement("span");
  brand.className = "topbar-brand";
  const brandIcon = document.createElement("img");
  brandIcon.src = `${import.meta.env.BASE_URL}favicon.svg`;
  brandIcon.alt = "";
  brandIcon.width = 20;
  brandIcon.height = 20;
  brand.appendChild(brandIcon);
  brand.appendChild(document.createTextNode("Track Recabler"));
  topbar.appendChild(brand);
  const topbarActions = document.createElement("div");
  topbarActions.className = "topbar-actions";
  topbar.appendChild(topbarActions);
  wrapper.appendChild(topbar);

  const container = document.createElement("div");
  container.className = "app-content";
  wrapper.appendChild(container);

  const howToCard = document.createElement("section");
  howToCard.className = "card tool-description how-to-card";
  howToCard.innerHTML = `<h2>How to use</h2><div class="tool-description-body">${mdToHtml(TOOL_HOW_TO_USE)}</div>`;

  if (!CLIENT_ID) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <p class="error">Missing <code>VITE_AUDIOTOOL_CLIENT_ID</code></p>
      <p class="status">Create an app at <a href="https://developer.audiotool.com/applications" target="_blank" rel="noopener">developer.audiotool.com/applications</a>, then add a <code>.env</code> file with:</p>
      <pre>VITE_AUDIOTOOL_CLIENT_ID=your_client_id</pre>
    `;
    container.appendChild(card);
    container.appendChild(createDisclaimerElement());
    container.appendChild(howToCard);
    return wrapper;
  }

  const search = new URLSearchParams(window.location.search);
  const hadOAuthParams = search.has("code") || search.has("state");

  let loginStatus = await getLoginStatus({
    clientId: CLIENT_ID,
    redirectUrl: REDIRECT_URL,
    scope: SCOPE,
  });

  // OAuth callback params in URL but login failed (e.g. Invalid state = stored state was lost). Clean URL and show friendly message so user can retry.
  if (!loginStatus.loggedIn && hadOAuthParams) {
    cleanOAuthParamsFromUrl();
    const isStateError =
      loginStatus.error?.message?.toLowerCase().includes("invalid state") ||
      loginStatus.error?.message?.includes("stale query");
    if (isStateError) {
      loginStatus = { ...loginStatus, error: new Error("Please try logging in again.") };
    }
  }

  if (loginStatus.loggedIn) {
    renderTopbarLoggedIn(topbarActions, loginStatus);
    renderMainContent(container, loginStatus);
  } else {
    renderTopbarLoggedOut(topbarActions, loginStatus);
    const prompt = document.createElement("div");
    prompt.className = "login-prompt";
    prompt.innerHTML = `<p>Log in with your Audiotool account to browse and migrate your projects.</p>
      <p class="login-redirect-hint" title="Must match exactly the redirect URI in your Audiotool app settings">Redirect URI: <code>${REDIRECT_URL}</code></p>`;
    container.appendChild(prompt);
  }

  container.appendChild(createDisclaimerElement());
  container.appendChild(howToCard);
  return wrapper;
}

/** Fill the topbar actions slot with Login (and optional error) when the user is not logged in. */
function renderTopbarLoggedOut(
  topbarActions: HTMLElement,
  status: Extract<LoginStatus, { loggedIn: false }>
): void {
  if (status.error) {
    const errSpan = document.createElement("span");
    errSpan.className = "topbar-error";
    errSpan.textContent = status.error.message;
    topbarActions.appendChild(errSpan);
  }
  const loginBtn = document.createElement("button");
  loginBtn.className = "btn-primary";
  loginBtn.textContent = "Login";
  loginBtn.onclick = () => status.login();
  topbarActions.appendChild(loginBtn);
}

/** Fill the topbar actions slot with username and Logout when the user is logged in. */
function renderTopbarLoggedIn(
  topbarActions: HTMLElement,
  status: LoginStatus & { loggedIn: true }
): void {
  const userSpan = document.createElement("span");
  userSpan.className = "topbar-user";
  userSpan.textContent = "Loading…";
  status.getUserName().then((name) => {
    const raw = typeof name === "string" ? name : "";
    userSpan.textContent = raw.startsWith("users/") ? raw.slice("users/".length) : raw;
  });
  topbarActions.appendChild(userSpan);
  const logoutBtn = document.createElement("button");
  logoutBtn.className = "btn-secondary";
  logoutBtn.textContent = "Logout";
  logoutBtn.onclick = () => status.logout();
  topbarActions.appendChild(logoutBtn);
}

/** Render main content when logged in: intro text, then project browser (after client is ready). */
function renderMainContent(
  container: HTMLElement,
  status: LoginStatus & { loggedIn: true }
): void {
  const intro = document.createElement("p");
  intro.className = "intro-text";
  intro.innerHTML = `Select a project to migrate to the new integrated mixer. We'll create a safe copy and rebuild your mix automatically. <a id="info-link">Learn more</a>`;
  intro.querySelector("#info-link")?.addEventListener("click", openWhatThisToolDoesModal);
  container.appendChild(intro);

  const loadingEl = document.createElement("p");
  loadingEl.className = "status";
  loadingEl.textContent = "Connecting…";
  container.appendChild(loadingEl);

  createAudiotoolClient({ authorization: status })
    .then(async (client) => {
      const username = await status.getUserName();
      loadingEl.remove();
      renderProjectConnect(container, client, typeof username === "string" ? username : undefined);
      appendHowToToBottom(container);
    })
    .catch((err) => {
      loadingEl.remove();
      const errCard = document.createElement("div");
      errCard.className = "card";
      errCard.innerHTML = `<p class="error">Failed to create Audiotool client: ${errorMessage(err)}</p>`;
      container.appendChild(errCard);
    });
}

/** Render the project URL input and 'Create copy & connect' button. On connect: validates URL, creates a copy of the project via the API, opens it in a new tab, and transitions to the document UI. */
function renderProjectConnect(
  container: HTMLElement,
  client: Awaited<ReturnType<typeof createAudiotoolClient>>,
  username?: string
): void {
  const card = document.createElement("div");
  card.className = "card";

  let selectedProjectId: string | null = null;
  const statusEl = document.createElement("p");
  statusEl.className = "status";

  const input = document.createElement("input");

  const connectBtn = document.createElement("button");
  connectBtn.className = "btn-primary";
  connectBtn.textContent = "Create copy & connect";

  if (username) {
    const listHeader = document.createElement("h3");
    listHeader.className = "project-list-header";
    listHeader.textContent = "Your Projects";
    card.appendChild(listHeader);

    const listContainer = document.createElement("div");
    listContainer.className = "project-list";
    listContainer.textContent = "Loading projects…";
    card.appendChild(listContainer);

    let ul: HTMLUListElement;
    let loadedProjects: ProjectListItem[] = [];

    const searchContainer = document.createElement("div");
    searchContainer.className = "project-list-search";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search projects...";
    searchContainer.appendChild(searchInput);
    card.insertBefore(searchContainer, listContainer);

    let searchTimeout: ReturnType<typeof setTimeout>;
    const applySearchAndRender = () => {
      renderProjectList(loadedProjects, searchInput.value.trim());
    };
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(applySearchAndRender, 300);
    });

    const renderProjectList = (projects: ProjectListItem[], searchQuery: string) => {
      ul.innerHTML = "";
      const q = searchQuery.toLowerCase();
      const filtered = searchQuery
        ? projects.filter((p) =>
            (p.displayName || p.name || "").toLowerCase().includes(q)
          )
        : projects;
      if (filtered.length === 0) {
        const empty = document.createElement("li");
        empty.className = "project-item project-item-empty";
        empty.textContent = searchQuery ? "No matching projects." : "No projects.";
        ul.appendChild(empty);
        return;
      }
      filtered.forEach((p) => {
        const li = document.createElement("li");
        li.className = "project-item";
        const placeholderUrl = `${import.meta.env.BASE_URL}placeholder-project.png`;
        const imageUrl = p.coverUrl || p.snapshotUrl || placeholderUrl;
        const img = document.createElement("img");
        img.className = "project-item-cover";
        img.src = imageUrl.includes("?") ? imageUrl : `${imageUrl}?width=80&height=80&fit=cover&format=webp`;
        img.alt = "";
        img.loading = "lazy";
        img.onerror = () => {
          if (img.src !== placeholderUrl) {
            img.src = placeholderUrl;
          }
        };
        li.appendChild(img);
        const nameSpan = document.createElement("span");
        nameSpan.className = "project-item-name";
        nameSpan.textContent = p.displayName || p.name || "Untitled";
        li.appendChild(nameSpan);
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "project-item-edit";
        editBtn.setAttribute("aria-label", "Rename project");
        editBtn.textContent = "\u270F"; // pencil symbol
        editBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openRenameProjectModal(p, client, (newDisplayName) => {
            const idx = loadedProjects.findIndex((x) => x.name === p.name);
            if (idx >= 0) {
              loadedProjects[idx] = { ...loadedProjects[idx], displayName: newDisplayName };
              applySearchAndRender();
            }
            if (selectedProjectId === projectIdFromName(p.name)) {
              statusEl.textContent = `Selected: ${newDisplayName}`;
            }
          });
        });
        li.appendChild(editBtn);
        const pId = projectIdFromName(p.name);
        li.onclick = () => {
          ul.querySelectorAll(".project-item.selected").forEach((el) =>
            el.classList.remove("selected")
          );
          li.classList.add("selected");
          selectedProjectId = pId;
          input.value = "";
          statusEl.textContent = `Selected: ${p.displayName || "Untitled"}`;
          statusEl.className = "status";
        };
        ul.appendChild(li);
      });
    };

    const fetchAllProjects = async () => {
      listContainer.innerHTML = "";
      ul = document.createElement("ul");
      ul.className = "project-list-ul";
      listContainer.textContent = "Loading projects…";

      let pageToken: string | undefined;
      try {
        do {
          const res = await client.api.projectService.listProjects({
            filter: `project.creator_name == "${username}"`,
            pageSize: 50,
            orderBy: "project.update_time desc",
            pageToken,
          });
          if (res instanceof Error) {
            listContainer.textContent = `Error loading projects: ${res.message}`;
            return;
          }
          loadedProjects.push(...(res.projects || []));
          pageToken = res.nextPageToken || undefined;
        } while (pageToken);

        listContainer.innerHTML = "";
        listContainer.appendChild(ul);
        applySearchAndRender();
      } catch (err) {
        listContainer.textContent = `Error: ${errorMessage(err)}`;
      }
    };

    void fetchAllProjects();
  }

  const label = document.createElement("label");
  label.textContent = username
    ? "Or paste original project URL"
    : "Original project URL (from beta.audiotool.com)";
  label.htmlFor = "project-url-input";
  card.appendChild(label);

  input.id = "project-url-input";
  input.type = "url";
  input.placeholder = "https://beta.audiotool.com/…";
  input.oninput = () => {
    if (input.value) {
      selectedProjectId = null;
      card
        .querySelectorAll(".project-item.selected")
        .forEach((el) => el.classList.remove("selected"));
      statusEl.textContent = "";
    }
  };
  card.appendChild(input);

  card.appendChild(statusEl);

  connectBtn.onclick = async () => {
    let projectId = selectedProjectId;
    
    if (!projectId) {
      const projectUrl = input.value.trim();
      if (!projectUrl) {
        statusEl.textContent = "Select a project or enter a URL.";
        statusEl.className = "status error";
        return;
      }
      projectId = getProjectIdFromUrl(projectUrl);
      if (!projectId) {
        statusEl.textContent = "Could not read project id from URL.";
        statusEl.className = "status error";
        return;
      }
    }

    statusEl.textContent = "Creating copy of project…";
    statusEl.className = "status";
    connectBtn.disabled = true;
    try {
      const copyOfProjectName = projectId.startsWith("projects/") ? projectId : `projects/${projectId}`;

      let displayName = "Recable copy";
      const getRes = await client.api.projectService.getProject({
        name: copyOfProjectName,
      });
      if (!(getRes instanceof Error) && getRes.project?.displayName?.trim()) {
        displayName = `${getRes.project.displayName.trim()} recabled`;
      }

      const createRes = await client.api.projectService.createProject({
        project: {
          copyOfProjectName,
          displayName,
        },
      });
      if (createRes instanceof Error) {
        statusEl.textContent = createRes.message;
        statusEl.className = "status error";
        connectBtn.disabled = false;
        return;
      }
      const newProject = createRes.project;
      if (!newProject?.name) {
        statusEl.textContent = "Copy created but no project id returned.";
        statusEl.className = "status error";
        connectBtn.disabled = false;
        return;
      }
      const remixId = projectIdFromName(newProject.name);
      const remixUrl = `${STUDIO_BASE}?project=${encodeURIComponent(remixId)}`;

      window.open(
        remixUrl,
        "_blank",
        "noopener,noreferrer,width=1280,height=800,left=100,top=100"
      );

      statusEl.textContent = "Connecting to copy…";
      const doc = await client.createSyncedDocument({ project: remixUrl });
      renderDocumentUI(container, doc, client, username);
      card.remove();
    } catch (err) {
      statusEl.textContent = errorMessage(err);
      statusEl.className = "status error";
      connectBtn.disabled = false;
    }
  };
  card.appendChild(connectBtn);
  const popupHint = document.createElement("p");
  popupHint.className = "status connect-hint";
  popupHint.textContent =
    "The project copy will open in a new window. If it doesn't, check whether a popup blocker is blocking it and allow popups for this site.";
  card.appendChild(popupHint);
  container.appendChild(card);
}

/** Render the main recable interface: Recable/Undo/Reset buttons, live event log, and document connection status. Subscribes to cable create/remove events for real-time logging. */
function renderDocumentUI(
  container: HTMLElement,
  doc: SyncedDocument,
  client: Awaited<ReturnType<typeof createAudiotoolClient>>,
  username?: string
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

  doc.connected.subscribe((connected: boolean) => {
    statusEl.textContent = connected
      ? "Connected"
      : "Disconnected (reconnecting…)";
    statusEl.className = connected ? "status connected" : "status error";
  });

  doc
    .start()
    .then(() => {
      statusEl.textContent = "Connected to copy — recable below.";
      statusEl.className = "status connected";
    })
    .catch((err) => {
      statusEl.textContent = `Sync failed: ${errorMessage(err)}`;
      statusEl.className = "status error";
    });

  const actions = document.createElement("div");
  actions.className = "actions";
  let lastRevertPayload: RevertPayload | null = null;
  const recableBtn = document.createElement("button");
  recableBtn.className = "btn-primary";
  recableBtn.textContent = "Recable";
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
      addLog(`Error: ${errorMessage(err)}`, "removed");
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
      addLog(`Revert error: ${errorMessage(err)}`, "removed");
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
    renderProjectConnect(container, client, username);
    appendHowToToBottom(container);
  };
  actions.appendChild(resetBtn);

  card.appendChild(actions);
  card.appendChild(logEl);
  container.appendChild(card);
  appendHowToToBottom(container);
}
