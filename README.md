# Track Recabler

A browser app that connects to [Audiotool](https://www.audiotool.com/) projects via the [Audiotool SDK](https://developer.audiotool.com/) and **recables old-style projects** so they use the new integrated mixer.

## What it does

In old Audiotool projects, the desktop had a single output. Signals were summed through desktop mixers: **Centroid**, **Kobolt**, **Minimixer**, and sometimes combined via an **Audio Merger**. In the new DAW, that chain ends in **one** channel on the integrated mixer. The Recabler finds the **last mixer** in that chain (the one feeding the single mixer channel), then **recables the whole setup** into the new mixer:

- **Channels** — Every cable that fed the last mixer’s inputs becomes its own **mixer channel**. Fader, pan, mute, solo, and (for Centroid) pre-gain and EQ are preserved. Automation is copied to the new channels.
- **Groups and hierarchy** — The **last mixer** becomes a **top-level group** in the new mixer. Any **submixer** that fed it (e.g. a Centroid or Kobolt) becomes a **subgroup** inside that group. If a submixer had another submixer cabled into it (e.g. Kobolt → Centroid), that nesting is preserved: **group inside group**. So you get one root group (last mixer) containing subgroups (Centroids, etc.), and those can contain further subgroups (Kobolt, Minimixer).
- **Merger** — If the last device is an **Audio Merger**, the app creates **one merger group** at the top. Each input that came from a submixer (e.g. two Centroids) becomes a **subgroup** inside the merger group, again with full nesting (e.g. Centroid → Kobolt → Minimixer).
- **Master insert** — The chain from the last mixer’s output to the stagebox (e.g. through FX) is wired to the **master insert** (send/return). Insert chains on submixers (e.g. Centroid insert → reverb) become the **group insert** of the corresponding subgroup.
- **Aux** — For every **aux** that was used (Centroid aux1/aux2, Minimixer aux; Kobolt has no aux), the app creates a **new mixer aux** for that source, reconnects the effect chain to it, and routes the right channels to it with the original send levels. Each Centroid or Minimixer gets its own aux strip(s), so multiple submixers with aux FX all stay correct.
- **Undo** — All changes are applied only to a **remix** (copy) of your project. You can **undo** the recable to restore the previous cabling; the original project is never modified.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- An [Audiotool](https://www.audiotool.com/) account

## Setup

### 1. Register your app

1. Go to [developer.audiotool.com/applications](https://developer.audiotool.com/applications).
2. Create an application.
3. Add **Redirect URI(s)**:
   - Local dev: `http://127.0.0.1:5173/`
   - GitHub Pages: `https://audiotool.github.io/recabler/`
4. Add the scope needed for synced documents (e.g. project write access — check the [Login docs](https://developer.audiotool.com/js-package-documentation/documents/Login.html) for the exact scope string).
5. Copy the **Client ID**.

### 2. Environment variables

Create a `.env` file in the project root:

```env
VITE_AUDIOTOOL_CLIENT_ID=your_client_id_here
```

Optional (defaults are fine for local dev):

```env
VITE_AUDIOTOOL_REDIRECT_URL=http://127.0.0.1:5173/
VITE_AUDIOTOOL_SCOPE=project:write
```

Use the same redirect URL and scope as in your app registration.

### 3. Install and run

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:5173/** in your browser (use this exact URL so OAuth redirect works).

### 4. Use the app

1. Click **Login with Audiotool** and authorize the app.
2. Open the **original** old-style project on [beta.audiotool.com](https://beta.audiotool.com/) (one where a Centroid, Kobolt, Minimixer or Merger feeds a single mixer channel), and copy its project URL.
3. Paste that URL into the app and click **Create copy & connect**. The app creates a **copy** of the project and connects to it. **The original project is never modified.**
4. Click **Recable**. The app finds the last mixer in the chain, then recables everything into the new integrated mixer: new channels, groups (with correct nesting), aux strips, and master insert. All changes apply only to the remix; the original stays untouched. Changes sync in real time with the DAW.
5. Use **Undo recable** to revert the recable in the remix if needed.

## Scripts

- `npm run dev` — start dev server at `http://127.0.0.1:5173`
- `npm run build` — TypeScript check + production build
- `npm run preview` — serve the production build locally
- `npm run test` — run unit and discovery tests (Vitest)

## Testing

Tests live under `src/recable/` (e.g. `mapping/eq.test.ts`, `tracing.test.ts`, `discovery.test.ts`). Run them with `npm run test`. Unit tests cover EQ/gain mapping, location helpers, cable creation, and discovery error paths (e.g. no mixer channels). See `docs/TESTING.md` for fixture schema and adding new tests.

## GitHub Pages

The app is published at **https://audiotool.github.io/recabler/**.

To enable the build:

1. In the repo: **Settings → Secrets and variables → Actions**, add a secret **`VITE_AUDIOTOOL_CLIENT_ID`** with your Audiotool app client ID.
2. In **Settings → Pages**, set **Source** to **Deploy from a branch**, branch **gh-pages**, folder **/ (root)**.
3. Push to `main` (or run the “Deploy to GitHub Pages” workflow manually). The workflow builds the app and pushes it to the `gh-pages` branch.

Ensure your Audiotool app has `https://audiotool.github.io/recabler/` as a Redirect URI.

## Document structure: which centroid track is automated

The studio UI may not always label which centroid *channel* (track) an automation lane belongs to, but that information **is in the document**:

- Each **`automationTrack`** entity has an **`automatedParameter`** field: a **`NexusLocation`** (entity id + optional field path).
- That location points to the **entity that owns the automated parameter** — either:
  - the **`centroidChannel`** entity itself (e.g. for a parameter stored directly on the channel), or
  - a **sub-entity** of that channel (e.g. a fader-parameters or EQ entity referenced by the channel).
- So “which centroid track is automated” is: the **centroid channel that owns the entity** in `automatedParameter.entityId`. If that entity is a sub-entity, the studio can resolve it to the parent `centroidChannel` (e.g. by finding which centroid channel references that entity). The channel’s **index** among the centroid’s channels (or its entity id) can then be used for a label like “Centroid 3 – Post Gain”.

## SDK version

This app uses **@audiotool/nexus@^0.0.11**. The [documentation](https://developer.audiotool.com/js-package-documentation/) references v0.0.12; that version currently pulls Node-only dependencies into the browser build and breaks `vite build`. We stay on 0.0.11 until the SDK provides a browser-safe build. Our code is compatible with the documented API (createSyncedDocument, projectService.createProject, etc.).

## Links

- [Audiotool Developer Dashboard](https://developer.audiotool.com/)
- [JS / Nexus SDK docs](https://developer.audiotool.com/js-package-documentation/)
- [Getting Started](https://developer.audiotool.com/js-package-documentation/documents/Getting_Started.html)
- [Login / OAuth](https://developer.audiotool.com/js-package-documentation/documents/Login.html)
- [Nexus SDK examples (GitHub)](https://github.com/audiotool/nexus-sdk-examples)
