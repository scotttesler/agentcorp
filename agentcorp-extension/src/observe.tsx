import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../app/styles.css";
import "../live.css";
import "../observe.css";
import { Simulation, initialProgress, DESKS, COFFEE_SPOTS, type Agent, type Request } from "../game/simulation";
import { EXTRA_DESKS, LIVE_COFFEE_Z, MAX_LIVE_DESKS, MIN_LIVE_DESKS, assignLoungeSpots, routeAroundDividers } from "../game/live-layout";
import { sampleDaylight } from "../game/lighting";
import { AGENTCORP_LETTERS, AGENTCORP_MARK, AGENTCORP_WORDMARK } from "../game/sprite-art";
import { createWorld } from "../game/world";
import { arrangeObservation, initials, needsYou, newAgent, noticeFor, parseObservation, sessionLink,
  type Member, type Observation } from "./observation-layout";
import { agentPersona } from "./room";
import { placeHover, placeTags, type TagBox } from "./tag-layout";

const MODE_LABELS: Record<NonNullable<Member["mode"]>, string> = {
  interactive: "Interactive", plan: "Plan", autopilot: "Autopilot",
};
const STATE_LABELS: Record<Member["state"], string> = {
  question: "Question", permission: "Permission", "plan-ready": "Plan ready",
  error: "Error", working: "Working", idle: "Idle",
};
const desks = [...DESKS, ...EXTRA_DESKS];
const coffee = COFFEE_SPOTS.map(({ x }) => ({ x, z: LIVE_COFFEE_Z + 0.75 }));
const STEP = 1 / 30;
const TAG_CROWN_HEIGHT = 2.9;
const AGENT_ASPECT = 0.25;
const themeKey = "agentcorp-harness-theme";
const wordmarkPaths = [...AGENTCORP_WORDMARK].map((letter, index) =>
  AGENTCORP_LETTERS[letter].flatMap((row, y) =>
    [...row].flatMap((bit, x) => bit === "1" ? [`M${index * 6 + x} ${y}h1v1h-1z`] : []),
  ).join(""));

function updateScene(scene: Simulation, members: Member[]) {
  const count = Math.min(members.length, MAX_LIVE_DESKS);
  scene.progress.capacity = count;
  scene.requests = [];
  const lounge = assignLoungeSpots(members.slice(MIN_LIVE_DESKS, count).map(member => member.state === "idle"));
  for (let index = 0; index < count; index++) {
    const member = members[index];
    const sprite = scene.agents[index];
    if (!sprite) throw new Error(`Missing office agent for desk ${index + 1}`);
    const busy = member.state !== "idle";
    const destination = busy ? desks[index] : index < MIN_LIVE_DESKS ? coffee[index] : lounge[index - MIN_LIVE_DESKS];
    if (!destination) throw new Error(`Missing office destination for desk ${index + 1}`);
    if (sprite.x === 100) { sprite.x = destination.x; sprite.z = destination.z; }
    if (sprite.target.x !== destination.x || sprite.target.z !== destination.z) {
      sprite.route = routeAroundDividers(sprite, destination);
    }
    sprite.target = { ...destination };
    sprite.taskId = busy ? index + 1 : undefined;
    if (busy) {
      const status: Request["status"] = member.state === "working" ? "working" : "failed";
      scene.requests.push({ id: index + 1, stationId: index, title: member.state,
        kind: "chat", status, progress: 0, reward: 0,
        ...(status === "failed" ? { resolvedAt: scene.time } : {}) });
    }
  }
}

function move(scene: Simulation) {
  for (let index = 0; index < scene.progress.capacity; index++) {
    const sprite = scene.agents[index];
    if (sprite.x === 100) continue;
    const point = sprite.route[0] ?? sprite.target;
    const distance = Math.hypot(point.x - sprite.x, point.z - sprite.z);
    const busy = sprite.taskId !== undefined;
    if (distance > 0.02) {
      const step = Math.min(distance, 2.05 * STEP);
      sprite.x += (point.x - sprite.x) / distance * step;
      sprite.z += (point.z - sprite.z) / distance * step;
      sprite.state = busy ? "walking" : "returning";
    } else {
      sprite.x = point.x; sprite.z = point.z;
      if (sprite.route.length) sprite.route.shift();
      sprite.state = sprite.route.length ? "returning" : busy ? "working" : "idle";
    }
  }
}

function openSession(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.click();
}

function Office() {
  const host = useRef<HTMLDivElement>(null);
  const manageButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panelOpener = useRef<HTMLButtonElement | null>(null);
  const restorePanelFocus = useRef(false);
  const world = useRef<ReturnType<typeof createWorld> | null>(null);
  const members = useRef<Member[]>([]);
  const priority = useRef<string[]>([]);
  const tags = useRef(new Map<string, HTMLDivElement>());
  const [state, setState] = useState<Observation | null>(null);
  const [error, setError] = useState("");
  const [sceneError, setSceneError] = useState("");
  const [themeError, setThemeError] = useState("");
  const [selected, setSelected] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [hover, setHover] = useState<{ id: string } | null>(null);
  const hoverIndex = useRef<number | null>(null);
  const hoverLabel = useRef<HTMLDivElement>(null);
  const [previewOffset, setPreviewOffset] = useState(0);
  const previewRef = useRef(0);
  const [themePreference, setThemePreference] = useState<"system" | "light" | "dark">(() => {
    const saved = localStorage.getItem(themeKey);
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const selectedRef = useRef("");
  const darkTheme = themePreference === "system" ? systemDark : themePreference === "dark";
  useLayoutEffect(() => { document.documentElement.dataset.officeTheme = darkTheme ? "dark" : "light"; }, [darkTheme]);
  useLayoutEffect(() => {
    if (!panelOpen && restorePanelFocus.current) {
      restorePanelFocus.current = false;
      (panelOpener.current ?? manageButton.current)?.focus();
    }
  }, [panelOpen]);
  const clearSelection = () => {
    selectedRef.current = "";
    setSelected("");
    hoverIndex.current = null;
    setHover(null);
    world.current?.focusAgent(null);
  };
  const openPanel = (opener?: HTMLButtonElement) => {
    panelOpener.current = opener ?? null;
    setPanelOpen(true);
  };
  const closePanel = () => {
    restorePanelFocus.current = true;
    clearSelection();
    setPanelOpen(false);
  };
  const focusMember = (index: number, showPanel = false) => {
    const member = members.current[index];
    if (!member) {
      setError("Selected agent is no longer visible. The office will retry on the next update.");
      return;
    }
    selectedRef.current = member.id;
    setSelected(member.id);
    hoverIndex.current = null;
    setHover(null);
    world.current?.focusAgent(index);
    if (showPanel) openPanel();
  };
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panelOpen]);
  const toggleTheme = () => {
    const next = darkTheme ? "light" : "dark";
    try {
      localStorage.setItem(themeKey, next);
      setThemePreference(next);
      setThemeError("");
    } catch (cause) {
      setThemeError(`Theme preference could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const previewLight = () => {
    previewRef.current = (previewRef.current + 0.25) % 1;
    setPreviewOffset(previewRef.current);
  };
  useEffect(() => {
    const office = host.current;
    if (!office) return;
    const scene = new Simulation(initialProgress());
    scene.agents = Array.from({ length: MIN_LIVE_DESKS }, (_, i) => newAgent(i));
    scene.progress.capacity = 0;
    scene.progress.context = false;
    scene.progress.workflow = 1;
    try {
      world.current = createWorld(office, scene, "live", {
        onAgentHover(index) {
          if (selectedRef.current) {
            const focused = members.current.findIndex(member => member.id === selectedRef.current);
            index = focused < 0 ? null : focused;
          }
          if (hoverIndex.current === index) return;
          hoverIndex.current = index;
          const member = index === null ? undefined : members.current[index];
          const point = index === null ? null : world.current?.projectAgent(index);
          setHover(member && point ? { id: member.id } : null);
        },
        noticeActivityForStation(index) {
          const member = members.current[index];
          return member ? noticeFor(member) : null;
        },
        attentionForAgent(index) {
          const member = members.current[index];
          return !!member && needsYou(member);
        },
        onAgentSelect(index) {
          const link = sessionLink(members.current[index]?.url ?? "");
          if (link) openSession(link);
          else focusMember(index, true);
        },
        agentTagAt(clientX, clientY) {
          for (const [id, tag] of tags.current) {
            if (!tag.hasAttribute("data-placed")) continue;
            const box = tag.getBoundingClientRect();
            if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) continue;
            const index = members.current.findIndex(member => member.id === id);
            if (index >= 0) return index;
          }
          return null;
        },
        onFocusCleared() {
          selectedRef.current = "";
          setSelected("");
          hoverIndex.current = null;
          setHover(null);
        },
      });
    } catch (cause) {
      office.classList.add("static-fallback");
      setSceneError(`3D office unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    let active = true;
    let refreshing = false;
    const key = encodeURIComponent(new URLSearchParams(location.search).get("key") ?? "");
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const response = await fetch(`/api/observations?key=${key}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Office returned ${response.status}`);
        const next = parseObservation(await response.json());
        if (!active) return;
        const hoveredId = hoverIndex.current === null ? "" : members.current[hoverIndex.current]?.id ?? "";
        const arranged = arrangeObservation(members.current, scene.agents, next.sessions);
        members.current = arranged.members;
        priority.current = next.sessions.map(member => member.id);
        scene.agents = arranged.agents;
        updateScene(scene, arranged.members);
        world.current?.capturePositions();
        arranged.members.forEach((member, index) => world.current?.setAgentPersona(index, agentPersona(member.id)));
        setState(next);
        setError("");
        const index = arranged.members.findIndex(member => member.id === selectedRef.current);
        if (selectedRef.current && index < 0) {
          const selectedRowHadFocus = document.activeElement?.matches('.observer-agent-row[aria-pressed="true"]');
          clearSelection();
          if (selectedRowHadFocus) closeButton.current?.focus();
        } else world.current?.focusAgent(index >= 0 ? index : null);
        const hoveredIndex = arranged.members.findIndex(member => member.id === hoveredId);
        hoverIndex.current = hoveredId && hoveredIndex >= 0 ? hoveredIndex : null;
        if (hoverIndex.current === null) setHover(null);
        else {
          const point = world.current?.projectAgent(hoveredIndex);
          setHover(point ? { id: hoveredId } : null);
        }
      } catch (cause) {
        if (active) setError(`Office update failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const poll = window.setInterval(() => void refresh(), 3_000);
    let frameId = 0;
    let last = performance.now();
    let remainder = 0;
    const frame = (now: number) => {
      remainder += Math.min((now - last) / 1000, 0.2);
      last = now;
      let advanced = false;
      if (!document.hidden) {
        while (remainder >= STEP) {
          world.current?.capturePositions();
          move(scene); scene.time += STEP;
          remainder -= STEP; advanced = true;
        }
        world.current?.render(now / 1000, previewRef.current, remainder / STEP, advanced);
        const boxes: TagBox[] = [];
        for (const id of priority.current) {
          const tag = tags.current.get(id);
          const index = members.current.findIndex(member => member.id === id);
          const feet = tag && index >= 0 ? world.current?.projectAgent(index, 0) : null;
          const crown = feet ? world.current?.projectAgent(index, TAG_CROWN_HEIGHT) : null;
          if (tag && feet && crown) {
            const x = Math.round(feet.x);
            const top = Math.round(crown.y);
            const bottom = Math.round(feet.y) + 6;
            const reach = (bottom - top) * AGENT_ASPECT / 2;
            boxes.push({ id, x, width: tag.offsetWidth, height: tag.offsetHeight,
              agent: { left: x - reach, right: x + reach, top, bottom } });
          }
        }
        const placed = placeTags(boxes, { width: office.clientWidth, height: office.clientHeight });
        const anchors = new Map(boxes.map(box => [box.id, box.x]));
        tags.current.forEach((tag, id) => {
          const position = placed.get(id);
          tag.toggleAttribute("data-placed", !!position);
          if (!position) return;
          const left = Math.round(position.left);
          if (tag.dataset.side !== position.side) tag.dataset.side = position.side;
          tag.style.setProperty("--anchor", `${(anchors.get(id) ?? left) - left}px`);
          tag.style.transform = `translate(${left}px, ${position.top}px)`;
        });
        const card = hoverLabel.current;
        if (hoverIndex.current !== null && card) {
          const point = world.current?.projectAgent(hoverIndex.current);
          const feet = world.current?.projectAgent(hoverIndex.current, 0);
          card.toggleAttribute("data-placed", !!point && !!feet);
          if (point && feet) {
            const { left, top } = placeHover({ x: point.x, top: point.y, bottom: feet.y },
              { width: card.offsetWidth, height: card.offsetHeight }, { width: office.clientWidth, height: office.clientHeight });
            card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
          }
        }
      } else remainder = 0;
      frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    return () => {
      active = false;
      window.clearInterval(poll);
      cancelAnimationFrame(frameId);
      world.current?.dispose();
      world.current = null;
    };
  }, []);
  const sessions = state?.sessions ?? [];
  const hovered = hover ? sessions.find(member => member.id === hover.id) : undefined;
  const live = sessions.length;
  const { needsYou: waiting, error: failing, working, idle } = state?.counts ??
    { needsYou: 0, error: 0, working: 0, idle: 0 };
  const waitingLabel = `${waiting} need${waiting === 1 ? "s" : ""} you`;
  const overflow = state?.overflow ?? 0;
  const moreLabel = `${overflow} more session${overflow === 1 ? "" : "s"}`;
  const visualError = error || sceneError || themeError;
  const connected = !error && state !== null;
  const statusKind = visualError ? "error" : !state || !live ? "connecting" : "online";
  const statusLabel = visualError ? "Error" : !state ? "Connecting" : live ? "Live" : "No sessions";
  const daylight = sampleDaylight(0, previewOffset);
  return <main className={`shell live-shell observer-shell ${panelOpen ? "activity-visible" : ""}`}>
    <header className="topbar">
      <div className="identity">
        <span className="brand-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" shapeRendering="crispEdges" focusable="false">
            {AGENTCORP_MARK.flatMap(({ color, rects }, layer) =>
              rects.map(([x, y, width, height], index) =>
                <rect key={`${layer}-${index}`} x={x} y={y} width={width} height={height} fill={color} />))}
          </svg>
        </span>
        <svg className="brand-wordmark" viewBox={`0 0 ${AGENTCORP_WORDMARK.length * 6 - 1} 7`}
          role="img" aria-label="agentcorp" shapeRendering="crispEdges">
          {wordmarkPaths.map((path, index) =>
            <path key={index} d={path} fill={index < 5 ? "var(--office-text)" : "var(--office-purple)"} />)}
        </svg>
        <div className="identity-controls">
          <button type="button" className="time-preview" onClick={previewLight}
            title="Preview the next six hours of decorative office lighting"
            aria-label={`Office lighting ${daylight.label}; preview next six hours`}>
            <span className="time-icon" aria-hidden="true">{daylight.sun > 1 ? "☼" : daylight.moon > 0.2 ? "☾" : "◑"}</span>
            <span className="time-value">{daylight.label}</span>
            <span className="time-arrow" aria-hidden="true">↻</span>
          </button>
          <button type="button" className="theme-toggle" onClick={toggleTheme}
            aria-label={`Switch to ${darkTheme ? "light" : "dark"} theme`}
            title={`HUD appearance: ${themePreference === "system" ? "system" : themePreference}`}>
            <span aria-hidden="true">{darkTheme ? "☼" : "☾"}</span>
          </button>
        </div>
      </div>
      <div className="top-stats" aria-hidden={panelOpen} inert={panelOpen}>
        <span className="observer-count">{live} observed{overflow > 0 && ` · ${moreLabel}`}</span>
        <button type="button" ref={manageButton} className="system-toggle" aria-expanded={panelOpen} aria-controls="system-panel"
          aria-label={`Manage agents${waiting ? `: ${waitingLabel}` : ""}`}
          onClick={event => openPanel(event.currentTarget)}>Manage agents
          {waiting > 0 && <span className="activity-attention" aria-hidden="true">{waiting}</span>}
          <span className="toggle-chevron" aria-hidden="true" /></button>
      </div>
    </header>
    <div className="layout">
      <section className="world-panel" aria-label="Live Copilot office">
        <div className="world-host" ref={host}>
          <div className="agent-tags" aria-hidden="true">
            {sessions.map(member => <div key={member.id} className={`agent-tag tag-${member.state}`}
              ref={element => {
                if (element) tags.current.set(member.id, element);
                else tags.current.delete(member.id);
              }}>
              <span className="agent-tag-name"><span className="agent-tag-title">{member.title}</span>
                {member.mode && <span className={`mode-badge mode-${member.mode}`}>{MODE_LABELS[member.mode]}</span>}</span>
              {member.state !== "idle" && <span className="agent-tag-activity">{member.activity}</span>}
            </div>)}
          </div>
          {hover && hovered && <div key={hovered.id} ref={hoverLabel} className="agent-hover">
            <span className="agent-tag-name"><span className="agent-tag-title">{hovered.title}</span>
              {hovered.mode && <span className={`mode-badge mode-${hovered.mode}`}>{MODE_LABELS[hovered.mode]}</span>}</span>
            <span className="agent-hover-activity">{hovered.activity}</span>
          </div>}
          <div className="world-callout live-callout" role="status" aria-live="polite">
            <button type="button" className={`office-status-link sdk-${statusKind}`}
              aria-label={`Observation status: ${statusLabel}. Open office overview`}
              title={visualError || "Read-only session activity"}
              onClick={event => openPanel(event.currentTarget)}>
              <span className="sdk-status-dot" aria-hidden="true" /> {statusLabel}
            </button>
            <span className="callout-separator" aria-hidden="true" />
            <span>{visualError || (!state ? "Connecting to local sessions…" : !live ?
              "No live sessions on this computer yet." :
              `${waiting ? `${waitingLabel} · ` : ""}${working} working · ${idle} idle${failing ? ` · ${failing} hit an error` : ""}${overflow ? ` · ${moreLabel} not shown` : ""}`)}</span>
          </div>
        </div>
      </section>
      <aside id="system-panel" className={`sidebar activity-panel ${panelOpen ? "sidebar-open" : ""}`}
        aria-label="Office overview" aria-hidden={!panelOpen} inert={!panelOpen}>
        <div className="activity-header">
          <div className="activity-title-row">
            <h2>Overview</h2>
            <button type="button" ref={closeButton} className="sidebar-close" onClick={closePanel} aria-label="Close overview">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
            </button>
          </div>
        </div>
        <div className="activity-scroll activity-list-scroll">
          <section className="activity-view overview-list" aria-label="Office overview status">
            <div className="activity-row activity-row-first">
              <div className="activity-row-heading"><strong>Connection</strong>
                <span className={`activity-tag ${connected ? "activity-tag-live" : error ? "activity-tag-warning" : ""}`}>
                  {error ? "Needs attention" : !state ? "Connecting" : "Connected"}</span></div>
              {error && <p role="alert">{error}</p>}
              <div className="activity-chips"><span className={waiting ? "attention" : ""}>{waitingLabel}</span>
                <span>{working} working</span><span>{idle} idle</span>
                {failing > 0 && <span className="attention">{failing} hit an error</span>}</div>
            </div>
            {sceneError && <div className="activity-row">
              <div className="activity-row-heading"><strong>3D scene</strong>
                <span className="activity-tag activity-tag-warning">Unavailable</span></div>
              <p>{sceneError} Session observations remain available below.</p>
            </div>}
            {themeError && <div className="activity-row">
              <div className="activity-row-heading"><strong>HUD preference</strong>
                <span className="activity-tag activity-tag-warning">Not saved</span></div>
              <p>{themeError}</p>
            </div>}
            <div className="activity-row">
              <div className="activity-row-heading"><strong>Observed agents</strong>
                <span className="activity-tag">{sessions.length} shown</span></div>
              {overflow > 0 && <p>{moreLabel} not shown (16-desk limit).</p>}
              {sessions.length ? <div className="activity-list">
                {sessions.map(member => {
                  const link = sessionLink(member.url);
                  return <div key={member.id} className={`observer-agent-item ${needsYou(member) ? "needs-you" : ""}`}>
                    <button type="button"
                      className={`activity-worker-row observer-agent-row ${selected === member.id ? "worker-selected" : ""}`}
                      aria-pressed={selected === member.id} disabled={!!sceneError}
                      onClick={() => {
                        if (selectedRef.current === member.id) clearSelection();
                        else focusMember(members.current.findIndex(current => current.id === member.id));
                      }}>
                      <span className="worker-avatar" aria-hidden="true">{initials(member.title)}</span>
                      <span className="activity-worker-info">
                        <span className="activity-worker-title"><strong>{member.title}</strong>
                          {member.mode && <span className={`mode-badge mode-${member.mode}`}>{MODE_LABELS[member.mode]}</span>}</span>
                        <span className="activity-current">{member.activity}</span>
                        <span className="activity-worker-meta">{member.id === state?.root ? "This session" : "Local session"} · desk {members.current.findIndex(current => current.id === member.id) + 1}</span>
                      </span>
                      <span className={`activity-tag status-${member.state}`}>{STATE_LABELS[member.state]}</span>
                    </button>
                    {link && <a className="session-open" href={link} target="_blank" rel="noopener noreferrer"
                      aria-label={`Open ${member.title}`}>Open</a>}
                  </div>;
                })}
              </div> : <p className="activity-empty">{!state ? "Finding local sessions…" :
                "No live sessions yet. Sessions appear once they load this extension; reload extensions in sessions that were open before it was installed."}</p>}
            </div>
            <div className="activity-row">
              <div className="activity-row-heading"><strong>Local observation</strong>
                <span className="activity-tag">Read only</span></div>
              <p>Each session on this computer shares only its title, mode and current activity through local files, never prompts, code or file contents. Sessions started by another session stay hidden, except those started by My Copilot. Closed sessions disappear within 45 seconds.</p>
            </div>
          </section>
        </div>
      </aside>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Office />);
