# agentcorp

![Isometric pixel-art AgentCorp office with desk wings, sofas, plants, and a coffee counter](assets/agentcorp-office.png)

## Bring your agents to life. 

A cozy office for local Copilot session agents. :) Understand your fleet of agents in a silly new way. 

This fork of [BranonConor/agentcorp](https://github.com/BranonConor/agentcorp) shows each session's title, mode and current activity, marks the sessions waiting on you, and opens a session when you click its agent.

## Install on this or another device

In a `github copilot app` session of choice, slap this prompt in:

```text
Install the agentcorp-extension from
https://github.com/scotttesler/agentcorp/tree/main/.github/extensions/agentcorp-extension
in my user scope, then open the AgentCorp · Live sessions canvas.
```

The repo-folder URL is the input to the app's `install_extension` flow;
installing from a repo folder copies the portable package into that device's
Copilot extensions. The installer will not overwrite an existing copy. To
update a user-scope install when `main` changes, remove it through the app's
extension management or move `$COPILOT_HOME/extensions/agentcorp-extension/`
outside the `extensions/` directory as a backup. Disabling it without removing
the folder does not free the install path. Reinstall from the same URL, then
reload extensions if they were not reloaded automatically. Live office records
stay in `$COPILOT_HOME/agentcorp-observer/`, outside the installed package.
`$COPILOT_HOME` defaults to `~/.copilot`.

The GitHub repository must be accessible to the device/account, and the
Copilot app must support extension canvases. Do not copy `agentcorp-extension/`
as the install folder: it holds build sources, not the packaged `extension.mjs`
and viewer.

Both project and user copies can launch here. When both are installed, the user
copy owns the canvas; without it, the project copy serves the canvas. Renamed
copies also defer to the canonical user install to avoid duplicate providers.
If the older `agentcorp-observer-viewer` user install is still present, it
continues to own the canvas until you remove it through the app's extension
management; the new copy stays inactive to avoid duplicate providers. Do not
remove the old install during an active session unless you intend to switch.

Each Copilot session on this computer that has loaded the extension decides from its first prompt whether it belongs in the office. Only the sessions that do publish a small presence record, and every office shows them. No enrollment is needed. Sessions that were open before you installed the extension appear after their extensions reload. A session appears after its first prompt.

Only sessions you started appear. A session that another session started stays out, except sessions that My Copilot started. My Copilot itself is hidden once one of its sessions has recorded its ID. Sub-agents are not drawn separately; they keep their session working. A sub-agent's permission request counts as its session needing you; its other requests don't. Sessions in containers, Codespaces or on other devices don't appear. Standalone Copilot CLI sessions also load your user extensions, so they can appear too, but clicking one doesn't open it in the app.

Each agent wears a name tag with its session's title and mode (Plan, Interactive or Autopilot). A working agent's tag also says what it's doing, such as "Running a command" or the intent the agent stated. A session with a question, a permission request or a plan to review gets a marker over its desk and a glowing ring. A session that hit an error gets a storm cloud until its next turn. Crowded tags slide sideways or flip above their agent to stay clear of each other and of other agents. Where there is still no room, a tag may cover another agent, or the lowest-priority tags hide. Hover an agent to see its full title and activity.

At most 16 sessions get desks. Sessions waiting on you come first, longest wait first, then sessions that hit an error, working sessions and idle ones, by title within each group. The office's own session is not guaranteed a desk. Additional sessions are counted as "more sessions," not drawn. A session that stops cleanly leaves right away; a record that isn't refreshed expires after 45 seconds. A session whose extension reloads mid-turn looks idle until its next event.

The title is the name you gave the session, else the latest title the app generated for it, else the name it was started with, else its summary, else a made-up name derived from its ID. Any of these except the name you gave is skipped when it looks copied from the first prompt, so a raw prompt doesn't show as a title. A session that another session started, such as one of My Copilot's, may still show a made-up name. The name the app shows for it lives in the app's own storage, which the office doesn't read, and the only name the session itself stores is its first prompt, which the office never uses. Rename it, for example with `/rename`, to give it a name the office shows.

Records hold only each session's ID, title, mode, state and that short activity line, never prompts, code, tool output or file contents. They stay on this computer, in private folders under `$COPILOT_HOME/agentcorp-observer/`: `presence/` holds one record per running session and `my-copilot/` holds empty files naming known My Copilot sessions. Each session reads the start of its own `events.jsonl` history to find its first prompt, and uses that prompt only to decide whether to appear and to keep prompt text out of its title. Older heartbeat files in `agentcorp-observer/artifacts` are left in place but no longer read, so a session still running an older copy of the extension appears only after its extensions reload.

Click an agent or its name tag in the office to open its session in the Copilot app. Select its full Observed agents row to focus the camera, or use the row's Open link. Rows work with Enter and Space; selecting the same row again clears focus. Dragging or scrolling the camera, pressing Escape, closing Overview, or losing the observed session also clears focus. A selected agent keeps its identity and desk through activity changes; the office does not automatically tour agents. Camera movement is eased unless reduced motion is preferred. In a narrow panel the camera crops the sides of the office; Overview still lists every desk.

Some of this relies on Copilot app behavior that isn't a documented SDK contract, or on SDK APIs marked experimental, and may change:

- Each copy of the extension learns its session's ID from the `SESSION_ID` environment variable, which the SDK reads but doesn't document. A session whose ID is missing or isn't a UUID stays out of the office.
- Each session finds its first prompt in the `events.jsonl` history in its session folder, on the first line that starts with `{"type":"user.message",`. It reads that message's `transformedContent`, which carries the app's blocks below, else its `content`. If that file is missing or has no prompt yet, the session decides at its next prompt. If its format changes, or it can't be read safely, the session stays out of the office.
- A session counts as started by another session when its first prompt has a `<copilot_tauri_workspace>` block with a `creator_*session_id:` line, or a `<cross_session_message>` block with a `from_project_session_id:` or `from_session_id:` line. Only the first block of each kind counts. If these formats change, such sessions may appear. A session that is later detached from its creator, or whose creator is archived, still stays out. A session that another session started without asking it to report back may lack these blocks, and then it appears. A block you paste into a first prompt counts too, unless the app's own block of that kind comes first, so pasting one into a new session's first prompt can hide that session.
- A session counts as started by My Copilot when that `<cross_session_message>` block also has `from_display_name: My Copilot`, or when its creator is a session already recorded as My Copilot; such a session checks that record on every heartbeat. If the app renames My Copilot, its sessions keep showing and My Copilot stays hidden until its record expires, up to 30 days after its last session with that display name ran; then its sessions drop out and My Copilot itself appears. A pasted block with that display name records the IDs it names as My Copilot, which hides those sessions.
- Titles and the starting mode come from the session's metadata snapshot: `workspace.user_named`, `workspace.name`, `initialName`, `summary` and `currentMode`. Each shown session also keeps the last title it announced in its own client metadata, under the `agentcorp-observer/title` key, so the title survives an extension reload. The SDK marks both metadata APIs experimental, and documents that client metadata is persisted with the local session and kept out of model context, events, telemetry, snapshots and remote exports.
- Opening a session uses the app's `ghapp://sessions/<session ID>` link, which assumes the app identifies a session by the same ID its runtime uses.

For the viewer build and tests, see [the source guide](agentcorp-extension/README.md).
