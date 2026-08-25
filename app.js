(() => {
  /*** State ***/
  /** @type {{id:number,title:string,tags:string[],endAt:number,createdAt:number,notified:boolean,snoozed:boolean,paused:boolean,pausedAt?:number,remainingAtPause?:number,originalDuration:number,daysOfWeek?:number[]}[]} */
  let timers = [];
  /** @type {{id:number,title:string,tags:string[],originalDuration:number,deletedAt:number,daysOfWeek?:number[]}[]} */
  let trash = [];
  /** @type {{id:number,title:string,tags:string[],originalDuration:number,archivedAt:number,daysOfWeek?:number[]}[]} */
  let archived = [];
  let seq = 1;

  const TRASH_RETENTION_MS = 5 * 60 * 1000;

  /*** LocalStorage ***/
  // Persists {seq, timers, trash, archived} as one JSON blob.
  // migrateLegacyStorage is a load()-only internal step, not exposed.
  const Storage = (() => {
    const STORAGE_KEY = "flex-timer-data";
    // TODO: Rename migration from the simple-timer era. Safe to remove around 2027.
    const LEGACY_STORAGE_KEY = "simple-timer-data";

    function migrateLegacyStorage() {
      if (localStorage.getItem(STORAGE_KEY) !== null) return;
      const legacyData = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyData === null) return;
      localStorage.setItem(STORAGE_KEY, legacyData);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }

    return {
      save() {
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ seq, timers, trash, archived }),
          );
        } catch (e) {
          console.warn("Failed to save to localStorage:", e);
        }
      },

      load() {
        try {
          migrateLegacyStorage();
          const data = localStorage.getItem(STORAGE_KEY);
          if (data) {
            const parsed = JSON.parse(data);
            seq = parsed.seq || 1;
            timers = parsed.timers || [];
            trash = parsed.trash || [];
            archived = parsed.archived || [];

            for (const t of [...timers, ...trash, ...archived]) {
              if (!Array.isArray(t.tags)) t.tags = [];
            }
          }
        } catch (e) {
          console.warn("Failed to load from localStorage:", e);
        }
      },
    };
  })();

  Storage.load();

  /*** Utilities ***/
  const html = (strings, ...values) => {
    return strings.reduce(
      (result, string) => `${result}${string}${values.shift() ?? ""}`,
      "",
    );
  };
  const $ = (sel, el = document) => el.querySelector(sel);
  const fmt2 = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const clamp0 = (ms) => (ms < 0 ? 0 : ms);

  // Pull #tag tokens out of a title string instead of requiring a
  // separate tags field: any "#" followed by non-whitespace becomes a
  // tag (normalized like the old comma-separated input — trimmed,
  // lowercased, deduped, sorted alphabetically regardless of input
  // order) and is removed from the displayed title.
  function extractTagsFromTitle(rawTitle) {
    const tags = [];
    const title = String(rawTitle || "")
      .replace(/#([^\s#]+)/g, (_, tag) => {
        tags.push(tag.toLowerCase());
        return "";
      })
      .replace(/\s+/g, " ")
      .trim();

    return { title, tags: [...new Set(tags)].sort() };
  }

  // Inverse of extractTagsFromTitle: reassemble the raw text a user
  // would type (title + trailing #tag tokens) so an edit form can be
  // seeded with something that round-trips back through it unchanged.
  function composeTitleWithTags(t) {
    const tagTokens = (t.tags || []).map((tag) => `#${tag}`).join(" ");
    return [t.title, tagTokens].filter(Boolean).join(" ");
  }

  // Duration/time-of-day computation and formatting: parsing, resolving
  // a timer's next end time, and rendering a duration back to the user
  // in various forms.
  // Point-in-time / calendar concerns: clock-time formatting, weekday
  // restrictions, and resolving a "time" mode timer's next occurrence.
  const Clock = (() => {
    // Push `target` forward in 24h steps until it lands on a day-of-week
    // present in `daysOfWeek` (0=Sunday..6=Saturday, matching
    // Date#getDay()). A no-op when daysOfWeek is empty/undefined, which
    // means "every day". Bounded to 7 iterations since some day within
    // a week is always allowed whenever daysOfWeek is non-empty.
    function advanceToAllowedDay(target, daysOfWeek) {
      if (!daysOfWeek || !daysOfWeek.length) return target;

      for (
        let i = 0;
        i < 7 && !daysOfWeek.includes(new Date(target).getDay());
        i++
      ) {
        target += 24 * 60 * 60 * 1000;
      }

      return target;
    }

    return {
      // time-only (no date)
      toTime(ts) {
        return new Date(ts).toLocaleTimeString([], { hour12: false });
      },

      isSameDay(a, b) {
        return new Date(a).toDateString() === new Date(b).toDateString();
      },

      // date with weekday, for tooltips on cross-day "Ends At" times
      toDateWithWeekday(ts) {
        return new Date(ts).toLocaleDateString([], {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          weekday: "short",
        });
      },

      // Short weekday names indexed like Date#getDay() (0=Sunday) —
      // this indexing is load-bearing (checkbox data-day values and
      // advanceToAllowedDay's day-of-week matching both key off it)
      // and must not change even though the UI displays/lists Monday
      // first.
      WEEKDAY_LABELS: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],

      // Display order for the weekday toggle buttons and
      // daysOfWeekLabel: Monday first, Sunday last (still
      // Date#getDay() values under the hood, just reordered for
      // presentation).
      WEEKDAY_DISPLAY_ORDER: [1, 2, 3, 4, 5, 6, 0],

      // Comma-joined weekday names (Monday-first) for a "time" mode
      // timer's daysOfWeek restriction, or "" when unrestricted
      // (fires every day).
      daysOfWeekLabel(daysOfWeek) {
        if (!daysOfWeek || !daysOfWeek.length) return "";
        const order = new Set(daysOfWeek);
        return Clock.WEEKDAY_DISPLAY_ORDER.filter((d) => order.has(d))
          .map((d) => Clock.WEEKDAY_LABELS[d])
          .join(", ");
      },

      // Resolve "HH:MM" or "HH:MM:SS" to the next occurrence of that
      // time (today if it hasn't passed yet, otherwise tomorrow),
      // further restricted to daysOfWeek if given. Seconds are
      // optional and default to 0.
      computeNextTimeBasedEndAt(timeStr, now = Date.now(), daysOfWeek) {
        const m = String(timeStr || "").match(
          /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
        );
        if (!m) return null;

        const hh = Number(m[1]);
        const mm = Number(m[2]);
        const ss = m[3] ? Number(m[3]) : 0;
        const d = new Date(now);
        d.setHours(hh, mm, ss, 0);

        let target = d.getTime();
        if (target <= now) target += 24 * 60 * 60 * 1000;

        return advanceToAllowedDay(target, daysOfWeek);
      },
    };
  })();

  // Elapsed-time-span concerns: parsing and formatting a duration
  // (milliseconds), for "duration" mode timers.
  const Duration = (() => {
    return {
      humanize(ms) {
        ms = Math.max(0, Math.round(ms));
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;

        return `${fmt2(h)}:${fmt2(m)}:${fmt2(s)}`;
      },

      parseDuration(input) {
        const s = String(input || "").trim();
        if (!s) return 0;

        if (/^\d+:\d{1,2}:\d{1,2}$/.test(s)) {
          const [h, m, sec] = s.split(":").map(Number);
          return (h * 60 * 60 + m * 60 + sec) * 1000;
        }

        if (/^\d+:\d{1,2}$/.test(s)) {
          const [m, sec] = s.split(":").map(Number);
          return (m * 60 + sec) * 1000;
        }

        if (/^\d+(?:\.\d+)?$/.test(s)) {
          // treat as minutes (allow decimals)
          return Math.round(parseFloat(s) * 60 * 1000);
        }

        // allow short units like 1h, 90s, 500ms, 2d
        const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
        if (m) {
          const v = parseFloat(m[1]);
          const unit = m[2].toLowerCase();

          if (unit === "ms") return Math.max(0, Math.round(v));
          if (unit === "s") return Math.round(v * 1000);
          if (unit === "m") return Math.round(v * 60 * 1000);
          if (unit === "h") return Math.round(v * 3600 * 1000);
          if (unit === "d") return Math.round(v * 86400 * 1000);
        }

        return 0;
      },

      // Snap a duration-based endAt to the second grid so its
      // countdown decrements in phase with other timers instead of
      // drifting by the sub-second remainder of Date.now() at
      // creation/resume time.
      alignEndAtToSecond(ms) {
        return Math.round(ms / 1000) * 1000;
      },

      formatDurationLabel(ms) {
        const totalSec = Math.round(Math.max(0, ms) / 1000);
        const d = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;

        const parts = [];
        if (d) parts.push(`${d}d`);
        if (h) parts.push(`${h}h`);
        if (m) parts.push(`${m}m`);
        if (s || parts.length === 0) parts.push(`${s}s`);

        return parts.join(" ");
      },

      // Render a duration back into an editable "H:MM:SS" / "MM:SS"
      // string (rather than formatDurationLabel's "1h 5m" form) so it
      // round-trips exactly through parseDuration when an edit is
      // saved unchanged.
      durationToEditableString(ms) {
        const totalSec = Math.round(Math.max(0, ms) / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;

        return h > 0 ? `${h}:${fmt2(m)}:${fmt2(s)}` : `${m}:${fmt2(s)}`;
      },
    };
  })();

  // Resolve the end time for (re)starting a timer, branching on its
  // mode — the one place duration-mode and time-mode logic meet, so it
  // isn't owned by either Duration or Clock.
  function computeRestartEndAt(t, now = Date.now()) {
    if (t.mode === "time") {
      return Clock.computeNextTimeBasedEndAt(t.targetTime, now, t.daysOfWeek);
    }

    return Duration.alignEndAtToSecond(now + t.originalDuration);
  }

  // Hot-path aliases: called inline in ActiveRow/TrashRow templates many
  // times per render, so kept unprefixed here for readability there —
  // Clock/Duration themselves still own the full time/duration API
  // surface. humanize is called just as often but deliberately excluded:
  // unlike these two, its name alone doesn't convey what it does without
  // the Duration. prefix for context.
  const toTime = Clock.toTime;
  const toDateWithWeekday = Clock.toDateWithWeekday;

  // The target time for "time" mode, or the configured duration for
  // "duration" mode — the plain configured value, with no
  // day-of-week restriction attached. Trailing ":00" seconds are
  // hidden since they're the common (omitted) case. Used for the
  // "Set" column in Archive/Trash, which has no room to spare for a
  // day list on top of it.
  function formatTimerLabel(t) {
    if (t.mode !== "time") {
      return Duration.formatDurationLabel(t.originalDuration);
    }

    const targetTime = String(t.targetTime).replace(
      /^(\d{1,2}:\d{2}):00$/,
      "$1",
    );
    return escapeHtml(targetTime);
  }

  // Fallback title for an untitled timer: formatTimerLabel(t), with a
  // day-of-week restriction prefixed (e.g. "Mon 10:00") since this is
  // the one place that restriction is visible without hovering the
  // mode badge's tooltip.
  function formatFallbackTitle(t) {
    const label = formatTimerLabel(t);
    const days = t.mode === "time" ? Clock.daysOfWeekLabel(t.daysOfWeek) : "";
    return days ? `${days} ${label}` : label;
  }

  // Shared line-icon set (stroke-based, 24x24 viewBox) used by the
  // Actions buttons, the status dot, and the mode badge, so every
  // glyph in the UI shares one stroke weight/color model instead of
  // mixing emoji drawn in unrelated styles. Color comes from the CSS
  // `color` of whatever wraps the icon (buttons already carry
  // accent/warn/danger/neutral colors; .status.ok/.paused/.done/
  // .snoozed too),
  // so call sites never need to pick a color themselves.
  // Icon rendering: inline stroked SVGs for row-action buttons, plus the
  // compact status dot and the Duration/Time mode badge built from them.
  const Icons = (() => {
    const STROKE_ICON_PATHS = {
      "refresh-cw": html`
        <polyline points="23 4 23 10 17 10"></polyline>
        <polyline points="1 20 1 14 7 14"></polyline>
        <path
          d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
        ></path>
      `,
      play: html`<polygon points="5 3 19 12 5 21 5 3"></polygon> `,
      pause: html`
        <rect x="6" y="4" width="4" height="16"></rect>
        <rect x="14" y="4" width="4" height="16"></rect>
      `,
      "skip-forward": html`
        <polygon points="5 4 15 12 5 20 5 4"></polygon>
        <line x1="19" y1="5" x2="19" y2="19"></line>
      `,
      archive: html`
        <polyline points="21 8 21 21 3 21 3 8"></polyline>
        <rect x="1" y="3" width="22" height="5"></rect>
        <line x1="10" y1="12" x2="14" y2="12"></line>
      `,
      trash: html`
        <line x1="2" y1="6" x2="22" y2="6"></line>
        <path d="M9 6V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4"></path>
        <path d="M4 6l1 14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2l1-14"></path>
        <line x1="10" y1="10" x2="10" y2="18"></line>
        <line x1="14" y1="10" x2="14" y2="18"></line>
      `,
      "corner-up-left": html`
        <polyline points="9 14 4 9 9 4"></polyline>
        <path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>
      `,
      edit: html`
        <path d="M12 20h9"></path>
        <path
          d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
        ></path>
      `,
      check: html`<polyline points="20 6 9 17 4 12"></polyline>`,
      x: html`
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      `,
      clock: html`
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      `,
      hourglass: html`
        <path
          d="M6 3h12M6 21h12M7 3Q7 10 12 12Q7 14 7 21M17 3Q17 10 12 12Q17 14 17 21"
        ></path>
      `,
      "chevron-down": html`<polyline points="6 9 12 15 18 9"></polyline>`,
      "chevron-up": html`<polyline points="18 15 12 9 6 15"></polyline>`,
      "clock-plus": html`
        <path d="M20.5 12A9.5 9.5 0 1 1 11 2.5"></path>
        <polyline points="11 8 11 12 14.5 14"></polyline>
        <line x1="17.7" y1="2.5" x2="17.7" y2="8.1"></line>
        <line x1="14.9" y1="5.3" x2="20.5" y2="5.3"></line>
      `,
    };

    return {
      icon(name, size = 18) {
        if (name === "circle") {
          return html`
            <svg
              viewBox="0 0 24 24"
              width="${size}"
              height="${size}"
              fill="currentColor"
            >
              <circle cx="12" cy="12" r="10"></circle>
            </svg>
          `;
        }

        // "More actions" row-menu toggle: three filled dots read better
        // than the stroked-outline treatment used for the other icons.
        if (name === "more-vertical") {
          return html`
            <svg
              viewBox="0 0 24 24"
              width="${size}"
              height="${size}"
              fill="currentColor"
            >
              <circle cx="12" cy="5" r="1.5"></circle>
              <circle cx="12" cy="12" r="1.5"></circle>
              <circle cx="12" cy="19" r="1.5"></circle>
            </svg>
          `;
        }

        return html`
          <svg
            viewBox="0 0 24 24"
            width="${size}"
            height="${size}"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            ${STROKE_ICON_PATHS[name]}
          </svg>
        `;
      },

      // Compact status glyph shown at narrow widths (kept visually
      // distinct from the Actions icons: a plain dot, not a shape like
      // play/pause). Color comes from the wrapping
      // .status.ok/.paused/.done/.snoozed class, so the dot itself
      // doesn't need to branch on statusText.
      statusIconFor(statusText) {
        return Icons.icon("circle", 14);
      },

      // Small badge indicating whether a timer was set by duration or
      // by a target clock time. Tooltip shows the concrete value (e.g.
      // the original duration, or the originally configured target
      // time — the latter matters once Snooze can push endAt past it)
      // so it's visible even when a title hides the fallback label.
      modeBadge(t) {
        const isTime = t.mode === "time";
        const days = isTime ? Clock.daysOfWeekLabel(t.daysOfWeek) : "";
        const label = isTime
          ? `At time: ${formatTimerLabel(t)}${days ? ` — ${days}` : ""}`
          : `Duration: ${Duration.formatDurationLabel(t.originalDuration)}`;

        return html`
          <span
            class="mode-badge"
            data-tooltip="${label}"
            aria-label="${label}"
          >
            ${isTime ? Icons.icon("clock", 14) : Icons.icon("hourglass", 14)}
          </span>
        `;
      },
    };
  })();

  // Hot-path aliases: icon() is called inline in row/form templates
  // dozens of times per render, and modeBadge() a handful of times —
  // Icons itself still owns the full API surface. statusIconFor isn't
  // aliased: it has only two call sites, nothing surprising to explain.
  const icon = Icons.icon;
  const modeBadge = Icons.modeBadge;

  /*** Sound ***/
  let audioCtx = null;
  function playBeep(times = 3, freq = 1000, duration = 0.18, gap = 0.08) {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }

      const now = audioCtx.currentTime;
      for (let i = 0; i < times; i++) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * (duration + gap));
        gain.gain.exponentialRampToValueAtTime(
          0.3,
          now + i * (duration + gap) + 0.01,
        );
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          now + i * (duration + gap) + duration,
        );
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + i * (duration + gap));
        osc.stop(now + i * (duration + gap) + duration + 0.05);
      }
    } catch (e) {
      /* ignore if audio is unavailable */
      console.warn("Audio playback failed:", e);
    }
  }

  const listEl = $("#timers");
  const timersEmptyEl = $("#timers-empty");
  const timersHeaderEl = $("#timers-header");
  const timersFooterEl = $("#timers-footer");

  /*** Render ***/
  function escapeHtml(s) {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return String(s).replace(/[&<>"']/g, (ch) => map[ch]);
  }

  // Small pill row rendered under a timer's title (empty string, i.e.
  // nothing rendered, when the timer has no tags). Each tag is
  // clickable to toggle it in that list's tag filter (see the click
  // handlers on listEl/trashListEl/archiveListEl below).
  function tagsHtml(t) {
    if (!t.tags || !t.tags.length) return "";

    return html`
      <div class="tags">
        ${t.tags
          .map(
            (tag) => html`
              <span class="tag" data-tag="${escapeHtml(tag)}">
                #${escapeHtml(tag)}
              </span>
            `,
          )
          .join("")}
      </div>
    `;
  }

  // Per-list tag filter state (OR match: a timer/trash/archive item is
  // shown if it has any of the selected tags). Kept in memory only —
  // intentionally not persisted, so filters reset on reload.
  let timersTagFilter = new Set();
  let archiveTagFilter = new Set();
  let trashTagFilter = new Set();

  // Whether each list's tag filter chip bar is expanded past its
  // collapsed one-row height (see .tag-filter-chips.collapsed). Kept
  // in memory only, like the filter sets above.
  let timersTagFilterExpanded = false;
  let archiveTagFilterExpanded = false;
  let trashTagFilterExpanded = false;

  // Sentinel filter value for the "No tags" chip, matching items with
  // an empty tags list. Tags are extracted via a regex that forbids
  // whitespace (see extractTagsFromTitle), so a value containing a
  // space can never collide with a real tag.
  const NO_TAGS_FILTER = "no tags";

  // Inline-edit state, shared across the Timers and Archived lists
  // (ids are globally unique, so one pair of variables is enough).
  // editingId is the id of the row currently showing the edit form;
  // editDraft holds its in-progress (unsaved) input values so they
  // survive a full renderActive()/renderArchived() triggered by
  // unrelated state changes (e.g. another timer finishing) instead of
  // resetting to the original values on every keystroke-unrelated
  // re-render.
  let editingId = null;
  let editDraft = null;

  // snoozingId/snoozeDraft mirror editingId/editDraft above, but for
  // the inline "extend by" form shown on a Done timer.
  let snoozingId = null;
  let snoozeDraft = null;

  // Tag-filtering feature shared by the Timers/Trash/Archived lists:
  // which tags are offered as chips, whether an item matches the
  // current filter, toggling a tag/clearing the filter, and rendering
  // the chip bar itself.
  const TagFilter = (() => {
    function availableTags(items) {
      const set = new Set();
      for (const t of items) {
        for (const tag of t.tags || []) set.add(tag);
      }

      return [...set].sort();
    }

    // Must match .tag-filter-chips.collapsed's max-height in the
    // <style>. 26px chip height + 6px margin-bottom (see
    // .tag-filter-chip) — scrollHeight includes that trailing
    // margin, so the threshold must too, or even a single row reads
    // as overflowing.
    const COLLAPSED_HEIGHT = 32;

    return {
      matches(t, filterSet) {
        if (!filterSet.size) return true;
        const tags = t.tags || [];
        if (filterSet.has(NO_TAGS_FILTER) && !tags.length) return true;
        return tags.some((tag) => filterSet.has(tag));
      },

      toggle(filterSet, tag) {
        if (filterSet.has(tag)) {
          filterSet.delete(tag);
        } else {
          filterSet.add(tag);
        }
      },

      // Renders the tag chip bar for one list, offering every tag
      // present among that list's own items (not just the currently
      // filtered subset), so deselecting a tag doesn't remove it
      // from the choices. When there are enough tags to wrap past
      // one row, the chip bar starts collapsed to one row with a
      // toggle to expand/collapse it (tracked via `expanded`, owned
      // by the caller) — otherwise a list with many distinct tags
      // eats a lot of vertical space before any timers/trash/archive
      // rows are visible.
      renderChips(containerEl, items, filterSet, expanded) {
        const tags = availableTags(items);
        const hasUntagged = items.some((t) => !t.tags || !t.tags.length);
        // Even with no tags left to offer as chips, keep rendering
        // when a filter is still active so "Clear filter" stays
        // reachable — otherwise emptying the list (e.g. by deleting
        // the last item with the filtered tag) strands the filter
        // with no way to reset it short of a reload.
        if (!tags.length && !hasUntagged && !filterSet.size) {
          containerEl.innerHTML = "";
          return;
        }

        containerEl.innerHTML = html`
          <div class="tag-filter-chips">
            ${tags
              .map(
                (tag) => html`
                  <button
                    type="button"
                    class="tag-filter-chip${filterSet.has(tag)
                      ? " active"
                      : ""}"
                    data-tag="${escapeHtml(tag)}"
                  >
                    #${escapeHtml(tag)}
                  </button>
                `,
              )
              .join("")}
            ${hasUntagged && tags.length
              ? html`
                  <button
                    type="button"
                    class="tag-filter-chip${filterSet.has(NO_TAGS_FILTER)
                      ? " active"
                      : ""}"
                    data-tag="${escapeHtml(NO_TAGS_FILTER)}"
                  >
                    (No tags)
                  </button>
                `
              : ""}
            ${filterSet.size
              ? html`<button type="button" class="tag-filter-clear">
                  Clear filter
                </button>`
              : ""}
          </div>
        `;

        // Measured before the "collapsed" class (and its max-height)
        // is applied, so scrollHeight reflects the bar's natural,
        // unclipped height — comparable directly against the CSS's
        // one-row cap.
        const chipsEl = containerEl.querySelector(".tag-filter-chips");
        const overflowsOneRow = chipsEl.scrollHeight > COLLAPSED_HEIGHT;
        chipsEl.classList.toggle("collapsed", overflowsOneRow && !expanded);
        if (overflowsOneRow) {
          const toggleHtml = html`
            <button type="button" class="tag-filter-toggle">
              <span class="tag-filter-toggle-label">
                ${icon(expanded ? "chevron-up" : "chevron-down", 12)}
                ${expanded ? "Show fewer tags" : "Show all tags"}
              </span>
            </button>
          `;

          if (expanded) {
            // Inserted as the *first* child (not appended) so every
            // chip after it in the DOM floats around it (see the
            // ".tag-filter-toggle" float rule in the <style>) — a
            // float only affects content that follows it, so it has
            // to come before the chips it's meant to make room for.
            chipsEl.insertAdjacentHTML("afterbegin", toggleHtml);
          } else {
            // Collapsed: rendered as a sibling and overlaid on top
            // of the one-row chip bar instead (see
            // ".tag-filter-chips.collapsed ~ .tag-filter-toggle" in
            // the <style>), so it visibly covers the tail end of the
            // truncated row rather than reserving room inside it.
            containerEl.insertAdjacentHTML("beforeend", toggleHtml);
          }
        }
      },

      // Handles a click anywhere in a tag filter chip bar
      // (select/deselect a tag, clear the filter, or
      // expand/collapse the chip bar via toggleExpanded).
      handleClick(e, filterSet, rerender, toggleExpanded) {
        const button = e.target.closest("button");
        if (!button) return;

        if (button.classList.contains("tag-filter-toggle")) {
          toggleExpanded();
        } else if (button.classList.contains("tag-filter-clear")) {
          filterSet.clear();
        } else {
          TagFilter.toggle(filterSet, button.dataset.tag);
        }

        rerender();
      },
    };
  })();

  // Inline edit form shown in place of a row's normal content.
  // Shared by the Timers and Archived lists: both item shapes carry
  // the same title/tags/mode/originalDuration/targetTime/daysOfWeek
  // fields.
  const EditForm = {
    html(t) {
      const draft = editDraft || {
        title: composeTitleWithTags(t),
        value:
          t.mode === "time"
            ? t.targetTime
            : Duration.durationToEditableString(t.originalDuration),
        daysOfWeek: t.daysOfWeek,
      };

      const valueField =
        t.mode === "time"
          ? html`
              <input
                type="time"
                step="1"
                class="edit-value"
                aria-label="At time"
                value="${escapeHtml(draft.value || "")}"
              />
            `
          : html`
              <input
                type="text"
                inputmode="numeric"
                class="edit-value"
                aria-label="Duration"
                placeholder="5:00 / 5 / 1h / 30s / 2d"
                value="${escapeHtml(draft.value || "")}"
              />
            `;

      // On its own second line (after title/value/controls) so the
      // first line stays identical in shape to the Duration mode
      // edit row instead of pushing Save/Cancel down to a third
      // line.
      const weekdayField =
        t.mode === "time"
          ? html`
              <div
                class="weekday-toggle-row"
                role="group"
                aria-label="Days of week (optional; none = every day)"
              >
                ${Clock.WEEKDAY_DISPLAY_ORDER.map(
                  (day) => html`
                    <input
                      type="checkbox"
                      id="edit-day-${t.id}-${day}"
                      data-day="${day}"
                      ${draft.daysOfWeek?.includes(day) ? "checked" : ""}
                    />
                    <label for="edit-day-${t.id}-${day}">
                      ${Clock.WEEKDAY_LABELS[day]}
                    </label>
                  `,
                ).join("")}
              </div>
            `
          : "";

      return html`
        <div class="edit-row">
          <input
            type="text"
            class="edit-title"
            aria-label="Title"
            placeholder="e.g., Tea #break / Meeting #work"
            value="${escapeHtml(draft.title || "")}"
          />
          ${valueField}
          <div class="controls">
            <button
              class="accent"
              data-act="save-edit"
              data-tooltip="Save"
              aria-label="Save"
              type="button"
            >
              ${icon("check")}
            </button>
            <button
              class="neutral"
              data-act="cancel-edit"
              data-tooltip="Cancel"
              aria-label="Cancel"
              type="button"
            >
              ${icon("x")}
            </button>
          </div>
          ${weekdayField}
        </div>
      `;
    },

    // Apply an edit form's current input values to `t` (a timer or
    // archived item — both share the same fields). Returns false
    // (leaving the edit form open) if the value field failed to
    // parse. Archived items have no endAt/paused/notified, so those
    // updates are skipped via the `"endAt" in t` guard, letting
    // active timers and archived items share this one method.
    apply(row, t) {
      const titleInput = $(".edit-title", row);
      const valueInput = $(".edit-value", row);
      const { title, tags } = extractTagsFromTitle(titleInput.value);
      const now = Date.now();

      if (t.mode === "time") {
        const targetTime = valueInput.value;
        const daysOfWeek = readDaysOfWeek(row);
        const endAt = Clock.computeNextTimeBasedEndAt(
          targetTime,
          now,
          daysOfWeek,
        );

        if (!targetTime || endAt == null) {
          alert("Enter a valid time (HH:MM or HH:MM:SS).");
          return false;
        }

        t.targetTime = targetTime;
        t.daysOfWeek = daysOfWeek;
        if ("endAt" in t) {
          t.endAt = endAt;
          t.notified = false;
          t.snoozed = false;
        }
      } else {
        const dur = Duration.parseDuration(valueInput.value);

        if (!dur || dur <= 0) {
          alert("Enter duration as mm:ss or minutes (number).");
          return false;
        }

        // Preserve elapsed time: shift endAt/remainingAtPause by
        // exactly the change in total duration, rather than
        // restarting the countdown from now.
        const delta = dur - t.originalDuration;
        t.originalDuration = dur;
        if ("endAt" in t) {
          if (t.paused) {
            t.remainingAtPause = clamp0((t.remainingAtPause || 0) + delta);
          } else {
            t.endAt += delta;
          }
          t.notified = false;
          t.snoozed = false;
        }
      }

      t.title = title;
      t.tags = tags;

      editingId = null;
      editDraft = null;
      return true;
    },

    focusTitle(containerEl) {
      const input = $(".editing .edit-title", containerEl);
      if (input) {
        input.focus();
        input.select();
      }
    },

    // Shared Enter-to-save / Escape-to-cancel handling for both
    // lists' edit forms. renderFn is whichever of
    // renderActive()/renderArchived() owns the row the event
    // originated in.
    handleKeydown(renderFn) {
      return (e) => {
        if (!e.target.matches(".edit-title, .edit-value")) return;

        if (e.key === "Escape") {
          editingId = null;
          editDraft = null;
          renderFn();
        } else if (e.key === "Enter") {
          // Ignore the Enter that confirms an IME composition (e.g.
          // finalizing Japanese kanji conversion) — it must not
          // also submit the edit.
          if (e.isComposing) return;

          const row = e.target.closest(".timer");
          const id = Number(row?.dataset.id);
          const t =
            timers.find((x) => x.id === id) ||
            archived.find((x) => x.id === id);

          if (t && EditForm.apply(row, t)) {
            Storage.save();
            renderFn();
          }
        }
      };
    },

    // Keep editDraft in sync with in-progress (unsaved) edits so a
    // full renderActive()/renderArchived() triggered by unrelated
    // state doesn't wipe them.
    handleInput(e) {
      if (editingId == null) return;

      const isWeekdayCheckbox = e.target.matches(
        '.weekday-toggle-row input[type="checkbox"]',
      );
      if (!isWeekdayCheckbox && !e.target.matches(".edit-title, .edit-value")) {
        return;
      }

      const row = e.target.closest(".timer");
      if (!row || Number(row.dataset.id) !== editingId) return;

      const t =
        timers.find((x) => x.id === editingId) ||
        archived.find((x) => x.id === editingId);
      if (!t) return;

      if (!editDraft) {
        editDraft = {
          title: composeTitleWithTags(t),
          value:
            t.mode === "time"
              ? t.targetTime
              : Duration.durationToEditableString(t.originalDuration),
          daysOfWeek: t.daysOfWeek,
        };
      }

      if (e.target.classList.contains("edit-title")) {
        editDraft.title = e.target.value;
      } else if (isWeekdayCheckbox) {
        editDraft.daysOfWeek = readDaysOfWeek(row);
      } else {
        editDraft.value = e.target.value;
      }
    },
  };

  // Inline "extend by" form shown in place of a Done timer's Ends
  // At/Remaining/Status/Controls — the title (unlike EditForm.html,
  // which replaces the whole row including the title) stays put.
  // Only offered for active timers, so unlike EditForm.html this
  // doesn't need to handle the archived-item shape.
  const SnoozeForm = {
    html(t) {
      const draft = snoozeDraft || { value: "5" };

      return html`
        <div class="edit-row snooze-row">
          <span class="snooze-label snooze-label-wide">Snooze for</span>
          <span class="snooze-label snooze-label-narrow">Snooze:</span>
          <input
            type="text"
            inputmode="numeric"
            class="snooze-value"
            aria-label="Snooze duration (mm:ss or minutes)"
            placeholder="5:00 / 5 / 1h / 30s"
            value="${escapeHtml(draft.value)}"
          />
          <div class="controls">
            <button
              class="accent"
              data-act="confirm-snooze"
              data-tooltip="Snooze"
              aria-label="Snooze"
              type="button"
            >
              ${icon("check")}
            </button>
            <button
              class="neutral"
              data-act="cancel-snooze"
              data-tooltip="Cancel"
              aria-label="Cancel"
              type="button"
            >
              ${icon("x")}
            </button>
          </div>
        </div>
      `;
    },

    // Apply a snooze form's current input value to `t`. Returns
    // false (leaving the form open) if the value doesn't parse to a
    // positive duration — same mm:ss / minutes / 1h / 30s / 2d
    // format as the Duration mode field, via Duration.parseDuration().
    // Deliberately doesn't touch originalDuration/targetTime, so a
    // later Restart still uses the timer's original setting rather
    // than the snoozed length.
    save(row, t) {
      const valueInput = $(".snooze-value", row);
      const dur = Duration.parseDuration(valueInput.value);

      if (!dur || dur <= 0) {
        alert("Enter snooze duration as mm:ss or minutes (number).");
        return false;
      }

      t.endAt = Duration.alignEndAtToSecond(Date.now() + dur);
      t.notified = false;
      t.snoozed = true;

      snoozingId = null;
      snoozeDraft = null;
      return true;
    },

    focusValue(containerEl) {
      const input = $(".snoozing .snooze-value", containerEl);
      if (input) {
        input.focus();
        input.select();
      }
    },

    // Enter-to-confirm / Escape-to-cancel for the snooze form. Only
    // active timers offer Snooze, so unlike EditForm.handleKeydown
    // this doesn't need a renderFn parameter — it always re-renders
    // the Timers list.
    handleKeydown(e) {
      if (!e.target.matches(".snooze-value")) return;

      if (e.key === "Escape") {
        snoozingId = null;
        snoozeDraft = null;
        renderActive();
      } else if (e.key === "Enter") {
        if (e.isComposing) return;

        const row = e.target.closest(".timer");
        const id = Number(row?.dataset.id);
        const t = timers.find((x) => x.id === id);

        if (t && SnoozeForm.save(row, t)) {
          Storage.save();
          renderActive();
        }
      }
    },

    // Keep snoozeDraft in sync with in-progress (unsaved) input so
    // a full renderActive() triggered by unrelated state doesn't
    // reset it back to the default value.
    handleInput(e) {
      if (snoozingId == null || !e.target.matches(".snooze-value")) {
        return;
      }

      const row = e.target.closest(".timer");
      if (!row || Number(row.dataset.id) !== snoozingId) return;

      snoozeDraft = { value: e.target.value };
    },
  };

  const timersTagFilterEl = $("#timers-tag-filter");

  // Builds and patches a single Active-timer row's markup. html() is
  // used by renderActive() for a full (re)build of a row; patch() is
  // used by tick()'s lightweight in-place update. Both go through the
  // same internal view model, so the two never drift out of sync with
  // each other the way two independently-written functions could.
  const ActiveRow = (() => {
    function computeViewModel(t, now) {
      const remaining = t.paused ? t.remainingAtPause || 0 : t.endAt - now;
      const done = remaining <= 0 && !t.paused;

      // Once Done, offer Snooze. Also keep offering it for the rest
      // of an already-snoozed run (not just once it's Done again) —
      // otherwise there's no way to shorten a snooze you regret,
      // since Edit only ever adjusts originalDuration, not this
      // one-off endAt override.
      const canSnooze = done || (t.snoozed && !t.paused);

      // Restart is normally only offered once a timer is Done (see
      // pauseResumeButton below), but a Duration-mode timer's target is
      // always just "originalDuration from now" — resetting it
      // mid-run is exactly as well-defined as resetting it after
      // completion, so offer a second, standalone Restart action for
      // that case. Time-mode timers are excluded: their target is an
      // absolute clock time, which Skip already handles for "move to
      // the next occurrence" and doesn't need a duration-style reset.
      const canRestart = !done && t.mode === "duration";

      let statusText, statusClass;
      if (t.paused) {
        statusText = "Paused";
        statusClass = "paused";
      } else if (done) {
        statusText = "Done";
        statusClass = "done";
      } else if (t.snoozed) {
        statusText = "Snoozed";
        statusClass = "snoozed";
      } else {
        statusText = "Running";
        statusClass = "ok";
      }

      const crossDay = !t.paused && !Clock.isSameDay(t.endAt, now);

      return {
        remaining,
        done,
        canSnooze,
        canRestart,
        statusText,
        statusClass,
        crossDay,
        paused: t.paused,
        mode: t.mode,
      };
    }

    // Renders a single row-action button from {act, tooltip, icon,
    // class}, or "" when spec is null (the action doesn't apply to
    // this timer). extraClass adds a controls-row-only modifier (e.g.
    // "wide-action") without affecting the same action's
    // row-menu-popover rendering.
    function actionButton(spec, extraClass = "") {
      if (!spec) return "";

      return html`
        <button
          class="${spec.class} ${extraClass}"
          data-act="${spec.act}"
          data-tooltip="${spec.tooltip}"
          aria-label="${spec.tooltip}"
          type="button"
        >
          ${icon(spec.icon)}
        </button>
      `;
    }

    // Unlike restartButton/skipButton/snoozeButton below, this slot's
    // button isn't a single yes/no condition — it's exactly one of
    // four mutually exclusive states (Done/Paused/Time mode/default).
    function pauseResumeButton(vm) {
      if (vm.done) {
        return actionButton({
          act: "restart",
          tooltip: "Restart",
          icon: "refresh-cw",
          class: "accent",
        });
      } else if (vm.paused) {
        return actionButton({
          act: "resume",
          tooltip: "Resume",
          icon: "play",
          class: "accent",
        });
      } else if (vm.mode === "time") {
        return "";
      } else {
        return actionButton({
          act: "pause",
          tooltip: "Pause",
          icon: "pause",
          class: "warn",
        });
      }
    }

    // Called with no extraClass for the row-menu-popover's copy of
    // this action, and with "wide-action" for the controls-row copy —
    // same action, just a different layout modifier.
    function restartButton(vm, extraClass = "") {
      return vm.canRestart
        ? actionButton(
            {
              act: "restart",
              tooltip: "Restart",
              icon: "refresh-cw",
              class: "accent",
            },
            extraClass,
          )
        : "";
    }

    function skipButton(vm) {
      return !vm.done && !vm.paused && vm.mode === "time"
        ? actionButton({
            act: "skip",
            tooltip: "Skip to next day",
            icon: "skip-forward",
            class: "accent",
          })
        : "";
    }

    // Only reached when t.id !== snoozingId — see html() below, which
    // replaces .controls (and everything else after .title) with
    // SnoozeForm.html() once this row's own form is open, so there's
    // no redundant trigger sitting next to it. Like restartButton, called
    // with no extraClass for the row-menu-popover's copy.
    function snoozeButton(vm, extraClass = "") {
      return vm.canSnooze
        ? actionButton(
            {
              act: "snooze",
              tooltip: "Snooze",
              icon: "clock-plus",
              class: "accent",
            },
            extraClass,
          )
        : "";
    }

    return {
      html(t, now) {
        const vm = computeViewModel(t, now);

        // .when picks up a "snoozed" class from t.snoozed so a
        // snoozed run's Ends At time stays visually distinct even
        // after it reaches Done again — t.snoozed is only cleared by
        // Restart or Edit (see EditForm.apply), which define a
        // genuinely
        // new run, deliberately not by tick()'s natural-completion
        // branch.
        const restOfRowHtml =
          t.id === snoozingId
            ? SnoozeForm.html(t)
            : html`
                <div class="when-remain">
                  <div
                    class="when ${t.snoozed ? "snoozed" : ""}"
                    ${vm.crossDay
                      ? `data-tooltip="${toDateWithWeekday(t.endAt)}" aria-label="${toDateWithWeekday(t.endAt)} — ${toTime(t.endAt)}"`
                      : ""}
                  >
                    ${t.paused ? "--:--:--" : toTime(t.endAt)}
                  </div>
                  <div class="remain">
                    ${Duration.humanize(clamp0(vm.remaining))}
                  </div>
                </div>
                <div
                  class="status ${vm.statusClass}"
                  aria-label="${vm.statusText}"
                  data-tooltip="${vm.statusText}"
                >
                  <span class="status-icon" aria-hidden="true">
                    ${Icons.statusIconFor(vm.statusText)}
                  </span>
                  <span class="status-text" aria-hidden="true">
                    ${vm.statusText}
                  </span>
                </div>
                <div class="controls">
                  ${pauseResumeButton(vm)} ${restartButton(vm, "wide-action")}
                  ${snoozeButton(vm, "wide-action")} ${skipButton(vm)}
                  <button
                    class="neutral wide-action"
                    data-act="edit"
                    data-tooltip="Edit"
                    aria-label="Edit"
                    type="button"
                  >
                    ${icon("edit")}
                  </button>
                  <button
                    class="neutral wide-action"
                    data-act="archive"
                    data-tooltip="Archive"
                    aria-label="Archive"
                    type="button"
                  >
                    ${icon("archive")}
                  </button>
                  <button
                    class="danger"
                    data-act="delete"
                    data-tooltip="Delete"
                    aria-label="Delete"
                    type="button"
                  >
                    ${icon("trash")}
                  </button>
                  <div class="row-menu">
                    <button
                      class="neutral"
                      data-act="toggle-menu"
                      data-tooltip="More actions"
                      aria-label="More actions"
                      aria-haspopup="true"
                      aria-expanded="false"
                      type="button"
                    >
                      ${icon("more-vertical")}
                    </button>
                    <div class="row-menu-popover">
                      ${restartButton(vm)} ${snoozeButton(vm)}
                      <button
                        class="neutral"
                        data-act="edit"
                        data-tooltip="Edit"
                        aria-label="Edit"
                        type="button"
                      >
                        ${icon("edit")}
                      </button>
                      <button
                        class="neutral"
                        data-act="archive"
                        data-tooltip="Archive"
                        aria-label="Archive"
                        type="button"
                      >
                        ${icon("archive")}
                      </button>
                    </div>
                  </div>
                </div>
              `;

        return html`
          <div class="title">
            <div class="title-main">
              ${modeBadge(t)}${t.title
                ? escapeHtml(t.title)
                : `<span class="when">(${formatFallbackTitle(t)})</span>`}
            </div>
            ${tagsHtml(t)}
          </div>
          ${restOfRowHtml}
        `;
      },

      patch(row, t, now) {
        const remainEl = $(".remain", row);
        const whenEl = $(".when-remain .when", row);
        const statusEl = $(".status", row);
        const statusIconEl = $(".status-icon", statusEl);
        const statusTextEl = $(".status-text", statusEl);

        const vm = computeViewModel(t, now);

        if (vm.crossDay) {
          const dateLabel = toDateWithWeekday(t.endAt);
          whenEl.setAttribute("data-tooltip", dateLabel);
          whenEl.setAttribute(
            "aria-label",
            `${dateLabel} — ${toTime(t.endAt)}`,
          );
        } else {
          whenEl.removeAttribute("data-tooltip");
          whenEl.removeAttribute("aria-label");
        }

        function setStatus(text, statusClass) {
          statusEl.setAttribute("aria-label", text);
          statusEl.setAttribute("data-tooltip", text);
          statusIconEl.innerHTML = Icons.statusIconFor(text);
          statusTextEl.textContent = text;
          statusEl.classList.remove("ok", "paused", "done", "snoozed");
          statusEl.classList.add(statusClass);
        }

        if (t.paused) {
          setStatus(vm.statusText, vm.statusClass);
          remainEl.textContent = Duration.humanize(clamp0(vm.remaining));
        } else if (vm.done) {
          setStatus(vm.statusText, vm.statusClass);
          remainEl.textContent = Duration.humanize(0);
        } else {
          remainEl.textContent = Duration.humanize(vm.remaining);
        }
      },
    };
  })();

  function renderActive() {
    TagFilter.renderChips(
      timersTagFilterEl,
      timers,
      timersTagFilter,
      timersTagFilterExpanded,
    );

    // sort by end time ascending
    const sorted = [...timers]
      .filter((t) => TagFilter.matches(t, timersTagFilter))
      .sort((a, b) => a.endAt - b.endAt);

    const timerEls = listEl.querySelectorAll(".timer:not(.list-header)");
    for (const timerEl of timerEls) {
      timerEl.remove();
    }

    timersEmptyEl.style.display = sorted.length ? "none" : "";
    timersEmptyEl.textContent = timers.length
      ? "No timers match the selected tags."
      : "No timers.";
    timersHeaderEl.style.display = sorted.length ? "" : "none";
    timersFooterEl.style.display = timers.length ? "" : "none";

    for (const t of sorted) {
      const row = document.createElement("div");
      row.dataset.id = String(t.id);

      if (t.id === editingId) {
        row.className = "timer editing";
        row.innerHTML = EditForm.html(t);
        listEl.appendChild(row);
        continue;
      }

      row.className = t.id === snoozingId ? "timer snoozing" : "timer";
      row.innerHTML = ActiveRow.html(t, Date.now());

      listEl.appendChild(row);
    }
  }

  const trashListEl = $("#trash-list");
  const trashEmptyEl = $("#trash-empty");
  const trashHeaderEl = $("#trash-header");
  const trashTagFilterEl = $("#trash-tag-filter");

  // Builds a single Trash row's markup, and patches its purge
  // countdown in tick()'s lightweight update — both share the same
  // purgesIn() so they can't drift apart.
  const TrashRow = (() => {
    function purgesIn(t, now) {
      return clamp0(TRASH_RETENTION_MS - (now - t.deletedAt));
    }

    return {
      html(t, now) {
        return html`
          <div class="title">
            <div class="title-main">
              ${modeBadge(t)}${t.title
                ? escapeHtml(t.title)
                : `<span class="when">(${formatFallbackTitle(t)})</span>`}
            </div>
            ${tagsHtml(t)}
          </div>
          <div class="set">${formatTimerLabel(t)}</div>
          <div class="remain">${Duration.humanize(purgesIn(t, now))}</div>
          <div class="controls">
            <button
              class="accent"
              data-act="restore"
              data-tooltip="Restore"
              aria-label="Restore"
              type="button"
            >
              ${icon("corner-up-left")}
            </button>
          </div>
        `;
      },

      patch(row, t, now) {
        $(".remain", row).textContent = Duration.humanize(purgesIn(t, now));
      },
    };
  })();

  function renderTrash() {
    TagFilter.renderChips(
      trashTagFilterEl,
      trash,
      trashTagFilter,
      trashTagFilterExpanded,
    );

    // sort by soonest to purge first
    const sorted = [...trash]
      .filter((t) => TagFilter.matches(t, trashTagFilter))
      .sort((a, b) => a.deletedAt - b.deletedAt);

    trashEmptyEl.style.display = sorted.length ? "none" : "";
    trashEmptyEl.textContent = trash.length
      ? "No trashed timers match the selected tags."
      : "Trash is empty.";
    trashHeaderEl.style.display = sorted.length ? "" : "none";
    trashListEl.innerHTML = "";

    const now = Date.now();
    for (const t of sorted) {
      const row = document.createElement("div");
      row.className = "timer trash-row";
      row.dataset.id = String(t.id);
      row.innerHTML = TrashRow.html(t, now);

      trashListEl.appendChild(row);
    }
  }

  function moveToTrash(t) {
    trash.push({
      id: t.id,
      title: t.title,
      mode: t.mode,
      originalDuration: t.originalDuration,
      targetTime: t.targetTime,
      daysOfWeek: t.daysOfWeek,
      tags: t.tags || [],
      deletedAt: Duration.alignEndAtToSecond(Date.now()),
    });
  }

  function purgeExpiredTrashItems() {
    const now = Date.now();
    const before = trash.length;
    trash = trash.filter((t) => now - t.deletedAt < TRASH_RETENTION_MS);
    return trash.length !== before;
  }

  const archiveListEl = $("#archive-list");
  const archiveEmptyEl = $("#archive-empty");
  const archiveHeaderEl = $("#archive-header");
  const archiveTagFilterEl = $("#archive-tag-filter");

  // Builds a single Archived row's markup. Archived rows have no live
  // countdown, so unlike ActiveRow/TrashRow there's no tick()-side
  // patch step — renderArchived() rebuilding on any structural change
  // is enough.
  const ArchivedRow = {
    html(t) {
      return html`
        <div class="title">
          <div class="title-main">
            ${modeBadge(t)}${t.title
              ? escapeHtml(t.title)
              : `<span class="when">(${formatFallbackTitle(t)})</span>`}
          </div>
          ${tagsHtml(t)}
        </div>
        <div class="set-archived">
          <div class="set">${formatTimerLabel(t)}</div>
          <div class="when">${toTime(t.archivedAt)}</div>
        </div>
        <div class="controls">
          <button
            class="accent"
            data-act="restart"
            data-tooltip="Restart"
            aria-label="Restart"
            type="button"
          >
            ${icon("refresh-cw")}
          </button>
          <button
            class="neutral"
            data-act="edit"
            data-tooltip="Edit"
            aria-label="Edit"
            type="button"
          >
            ${icon("edit")}
          </button>
          <button
            class="danger"
            data-act="delete"
            data-tooltip="Delete"
            aria-label="Delete"
            type="button"
          >
            ${icon("trash")}
          </button>
        </div>
      `;
    },
  };

  function renderArchived() {
    TagFilter.renderChips(
      archiveTagFilterEl,
      archived,
      archiveTagFilter,
      archiveTagFilterExpanded,
    );

    // most recently archived first
    const sorted = [...archived]
      .filter((t) => TagFilter.matches(t, archiveTagFilter))
      .sort((a, b) => b.archivedAt - a.archivedAt);

    archiveEmptyEl.style.display = sorted.length ? "none" : "";
    archiveEmptyEl.textContent = archived.length
      ? "No archived timers match the selected tags."
      : "No archived timers.";
    archiveHeaderEl.style.display = sorted.length ? "" : "none";
    archiveListEl.innerHTML = "";

    for (const t of sorted) {
      const row = document.createElement("div");
      row.dataset.id = String(t.id);

      if (t.id === editingId) {
        row.className = "timer archive-row editing";
        row.innerHTML = EditForm.html(t);
        archiveListEl.appendChild(row);
        continue;
      }

      row.className = "timer archive-row";
      row.innerHTML = ArchivedRow.html(t);

      archiveListEl.appendChild(row);
    }
  }

  function moveToArchive(t) {
    archived.push({
      id: t.id,
      title: t.title,
      mode: t.mode,
      originalDuration: t.originalDuration,
      targetTime: t.targetTime,
      daysOfWeek: t.daysOfWeek,
      tags: t.tags || [],
      archivedAt: Date.now(),
    });
  }

  function setupStickyFormShadow() {
    const sentinel = $(".sticky-sentinel");
    const form = $(".sticky-form");
    if (!sentinel || !form) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        form.classList.toggle("stuck", !entry.isIntersecting);
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);
  }

  /*** Actions ***/
  // Toggle Duration/At-time input fields based on the selected mode
  const durationFieldEl = $("#duration-field");
  const timeFieldEl = $("#time-field");
  const weekdayFieldEl = $("#weekday-field");
  const durationInputEl = $("#duration");
  const targetTimeInputEl = $("#target-time");

  // Read the checked days from a .weekday-toggle-row's checkboxes
  // within `container`, returning undefined (meaning "every day")
  // when none *or all* are checked — selecting every day is the same
  // restriction as selecting none, so it's normalized the same way
  // rather than showing as a (redundant) 7-day restriction elsewhere.
  // Shared by the add-timer form and the inline edit row, both of
  // which render one .weekday-toggle-row.
  function readDaysOfWeek(container) {
    const days = [
      ...container.querySelectorAll(
        '.weekday-toggle-row input[type="checkbox"]:checked',
      ),
    ].map((cb) => Number(cb.dataset.day));
    return days.length && days.length < 7 ? days : undefined;
  }

  // Set a .weekday-toggle-row's checkboxes within `container` to
  // reflect `daysOfWeek` (undefined/empty checks none, meaning
  // "every day").
  function setDaysOfWeekCheckboxes(container, daysOfWeek) {
    const set = new Set(daysOfWeek || []);
    container
      .querySelectorAll('.weekday-toggle-row input[type="checkbox"]')
      .forEach((cb) => {
        cb.checked = set.has(Number(cb.dataset.day));
      });
  }

  function updateModeFieldsVisibility() {
    const isTime = $('input[name="mode"]:checked').value === "time";
    durationFieldEl.style.display = isTime ? "none" : "";
    timeFieldEl.style.display = isTime ? "" : "none";
    weekdayFieldEl.style.display = isTime ? "" : "none";
    durationInputEl.required = !isTime;
    targetTimeInputEl.required = isTime;
    $("#title").focus();
  }

  // Re-clicking the already-selected radio fires "click" but not
  // "change" (its value doesn't change), yet should still refocus the
  // title field. Track the selected value so "click" only re-runs the
  // update for that no-op case, instead of doubling up with "change"
  // whenever a click actually switches the mode.
  let currentMode = $('input[name="mode"]:checked').value;

  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.addEventListener("change", () => {
      currentMode = el.value;
      updateModeFieldsVisibility();
    });
    el.addEventListener("click", () => {
      if (el.value === currentMode) updateModeFieldsVisibility();
    });
  });

  updateModeFieldsVisibility();

  // Create timer (Enter or button click)
  $("#timer-form").addEventListener("submit", (e) => {
    e.preventDefault();

    const { title, tags } = extractTagsFromTitle($("#title").value);
    const mode = $('input[name="mode"]:checked').value;
    const now = Date.now();

    let endAt, originalDuration, targetTime, daysOfWeek;

    if (mode === "time") {
      targetTime = targetTimeInputEl.value;
      daysOfWeek = readDaysOfWeek($("#timer-form"));
      endAt = Clock.computeNextTimeBasedEndAt(targetTime, now, daysOfWeek);

      if (!targetTime || endAt == null) {
        alert("Enter a valid time (HH:MM or HH:MM:SS).");
        return;
      }
    } else {
      const dur = Duration.parseDuration($("#duration").value);

      if (!dur || dur <= 0) {
        alert("Enter duration as mm:ss or minutes (number).");
        return;
      }

      originalDuration = dur;
      endAt = Duration.alignEndAtToSecond(now + dur);
    }

    timers.push({
      id: seq++,
      title,
      tags,
      mode,
      endAt,
      createdAt: now,
      notified: false,
      snoozed: false,
      paused: false,
      originalDuration,
      targetTime,
      daysOfWeek,
    });

    $("#title").value = "";
    $("#duration").value = "";
    targetTimeInputEl.value = "";
    setDaysOfWeekCheckboxes($("#timer-form"), undefined);
    $("#mode-duration").checked = true;
    updateModeFieldsVisibility();

    Storage.save();
    renderActive();

    $("#title").focus();
  });

  // Actions available on an Active-list row, dispatched by data-act
  // from the click handler below.
  const ActiveActions = {
    delete(t) {
      timers = timers.filter((x) => x.id !== t.id);
      moveToTrash(t);
      Storage.save();
      renderActive();
      renderTrash();
    },

    archive(t) {
      timers = timers.filter((x) => x.id !== t.id);
      moveToArchive(t);
      Storage.save();
      renderActive();
      renderArchived();
    },

    pause(t) {
      const now = Date.now();
      t.paused = true;
      t.pausedAt = now;
      t.remainingAtPause = t.endAt - now;
      Storage.save();
      renderActive();
    },

    resume(t) {
      const now = Date.now();
      t.paused = false;
      t.endAt = Duration.alignEndAtToSecond(now + (t.remainingAtPause || 0));
      t.notified = false;
      delete t.pausedAt;
      delete t.remainingAtPause;
      Storage.save();
      renderActive();
    },

    restart(t) {
      const now = Date.now();
      t.endAt = computeRestartEndAt(t, now);
      t.createdAt = now;
      t.notified = false;
      t.snoozed = false;
      t.paused = false;
      delete t.pausedAt;
      delete t.remainingAtPause;
      Storage.save();
      renderActive();
    },

    // While snoozed, t.endAt holds the snooze re-fire time rather
    // than an on-schedule target-time instant, so re-deriving from
    // t.targetTime (anchored to t.endAt's calendar day) rather than
    // just adding 24h keeps the skip aligned to the actual target
    // time even mid-snooze.
    skip(t) {
      t.endAt = Clock.computeNextTimeBasedEndAt(
        t.targetTime,
        t.endAt,
        t.daysOfWeek,
      );
      t.snoozed = false;
      Storage.save();
      renderActive();
    },

    startEdit(id) {
      editingId = id;
      editDraft = null;
      snoozingId = null;
      snoozeDraft = null;
      renderActive();
      EditForm.focusTitle(listEl);
    },

    cancelEdit() {
      editingId = null;
      editDraft = null;
      renderActive();
    },

    saveEdit(row, t) {
      if (EditForm.apply(row, t)) {
        Storage.save();
        renderActive();
      }
    },

    startSnooze(id) {
      snoozingId = id;
      snoozeDraft = null;
      editingId = null;
      editDraft = null;
      renderActive();
      SnoozeForm.focusValue(listEl);
    },

    cancelSnooze() {
      snoozingId = null;
      snoozeDraft = null;
      renderActive();
    },

    confirmSnooze(row, t) {
      if (SnoozeForm.save(row, t)) {
        Storage.save();
        renderActive();
      }
    },

    toggleMenu(button) {
      const menu = button.closest(".row-menu");
      const isOpen = menu?.classList.toggle("open");
      button.setAttribute("aria-expanded", String(!!isOpen));
    },

    deleteAll() {
      for (const t of timers) {
        moveToTrash(t);
      }
      timers = [];
      Storage.save();
      renderActive();
      renderTrash();
    },
  };

  // Timer controls (pause/resume/restart/delete)
  listEl.addEventListener("click", (e) => {
    const tagEl = e.target.closest(".tag");
    if (tagEl) {
      TagFilter.toggle(timersTagFilter, tagEl.dataset.tag);
      renderActive();
      return;
    }

    const button = e.target.closest("button");
    if (!button) return;
    const act = button.getAttribute("data-act");
    const row = button.closest(".timer");
    const id = Number(row?.dataset.id);
    const t = timers.find((x) => x.id === id);

    if (act === "delete" && t) {
      ActiveActions.delete(t);
    } else if (act === "archive" && t) {
      ActiveActions.archive(t);
    } else if (act === "pause" && t && !t.paused) {
      ActiveActions.pause(t);
    } else if (act === "resume" && t && t.paused) {
      ActiveActions.resume(t);
    } else if (act === "restart" && t) {
      ActiveActions.restart(t);
    } else if (act === "skip" && t && t.mode === "time") {
      ActiveActions.skip(t);
    } else if (act === "edit" && t) {
      ActiveActions.startEdit(id);
    } else if (act === "cancel-edit") {
      ActiveActions.cancelEdit();
    } else if (act === "save-edit" && t) {
      ActiveActions.saveEdit(row, t);
    } else if (act === "snooze" && t) {
      ActiveActions.startSnooze(id);
    } else if (act === "cancel-snooze") {
      ActiveActions.cancelSnooze();
    } else if (act === "confirm-snooze" && t) {
      ActiveActions.confirmSnooze(row, t);
    } else if (act === "toggle-menu") {
      ActiveActions.toggleMenu(button);
    }
  });

  listEl.addEventListener("input", EditForm.handleInput);
  listEl.addEventListener("keydown", EditForm.handleKeydown(renderActive));
  listEl.addEventListener("input", SnoozeForm.handleInput);
  listEl.addEventListener("keydown", SnoozeForm.handleKeydown);

  // Close any open row-menu popover (see .row-menu in the CSS) when
  // clicking outside of it, matching normal dropdown behavior.
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".row-menu.open").forEach((menu) => {
      if (!menu.contains(e.target)) {
        menu.classList.remove("open");
        $('[data-act="toggle-menu"]', menu)?.setAttribute(
          "aria-expanded",
          "false",
        );
      }
    });
  });

  // Rebuilds a fresh Active timer entry from a Trash or Archived
  // item — shared by restoreFromTrash and restartFromArchive, which
  // otherwise duplicate this exact object shape.
  function reviveTimer(t, now) {
    return {
      id: seq++,
      title: t.title,
      tags: t.tags || [],
      mode: t.mode,
      endAt: computeRestartEndAt(t, now),
      createdAt: now,
      notified: false,
      snoozed: false,
      paused: false,
      originalDuration: t.originalDuration,
      targetTime: t.targetTime,
      daysOfWeek: t.daysOfWeek,
    };
  }

  // Actions available on a Trash-list row, dispatched by data-act
  // from the click handler below.
  const TrashActions = {
    restore(t) {
      trash = trash.filter((x) => x.id !== t.id);
      timers.push(reviveTimer(t, Date.now()));
      Storage.save();
      renderActive();
      renderTrash();
    },
  };

  // Trash controls (restore)
  trashListEl.addEventListener("click", (e) => {
    const tagEl = e.target.closest(".tag");
    if (tagEl) {
      TagFilter.toggle(trashTagFilter, tagEl.dataset.tag);
      renderTrash();
      return;
    }

    const button = e.target.closest("button");
    if (!button) return;
    const act = button.getAttribute("data-act");
    const row = button.closest(".timer");
    const id = Number(row?.dataset.id);
    const t = trash.find((x) => x.id === id);
    if (!t) return;

    if (act === "restore") {
      TrashActions.restore(t);
    }
  });

  // Actions available on an Archived-list row, dispatched by
  // data-act from the click handler below.
  const ArchiveActions = {
    restart(t) {
      archived = archived.filter((x) => x.id !== t.id);
      timers.push(reviveTimer(t, Date.now()));
      Storage.save();
      renderActive();
      renderArchived();
    },

    delete(t) {
      archived = archived.filter((x) => x.id !== t.id);
      moveToTrash(t);
      Storage.save();
      renderArchived();
      renderTrash();
    },

    startEdit(id) {
      editingId = id;
      editDraft = null;
      renderArchived();
      EditForm.focusTitle(archiveListEl);
    },

    cancelEdit() {
      editingId = null;
      editDraft = null;
      renderArchived();
    },

    saveEdit(row, t) {
      if (EditForm.apply(row, t)) {
        Storage.save();
        renderArchived();
      }
    },
  };

  // Archive controls (restart/delete)
  archiveListEl.addEventListener("click", (e) => {
    const tagEl = e.target.closest(".tag");
    if (tagEl) {
      TagFilter.toggle(archiveTagFilter, tagEl.dataset.tag);
      renderArchived();
      return;
    }

    const button = e.target.closest("button");
    if (!button) return;
    const act = button.getAttribute("data-act");
    const row = button.closest(".timer");
    const id = Number(row?.dataset.id);
    const t = archived.find((x) => x.id === id);
    if (!t) return;

    if (act === "restart") {
      ArchiveActions.restart(t);
    } else if (act === "delete") {
      ArchiveActions.delete(t);
    } else if (act === "edit") {
      ArchiveActions.startEdit(id);
    } else if (act === "cancel-edit") {
      ArchiveActions.cancelEdit();
    } else if (act === "save-edit") {
      ArchiveActions.saveEdit(row, t);
    }
  });

  archiveListEl.addEventListener("input", EditForm.handleInput);
  archiveListEl.addEventListener(
    "keydown",
    EditForm.handleKeydown(renderArchived),
  );

  timersTagFilterEl.addEventListener("click", (e) => {
    TagFilter.handleClick(e, timersTagFilter, renderActive, () => {
      timersTagFilterExpanded = !timersTagFilterExpanded;
    });
  });
  trashTagFilterEl.addEventListener("click", (e) => {
    TagFilter.handleClick(e, trashTagFilter, renderTrash, () => {
      trashTagFilterExpanded = !trashTagFilterExpanded;
    });
  });
  archiveTagFilterEl.addEventListener("click", (e) => {
    TagFilter.handleClick(e, archiveTagFilter, renderArchived, () => {
      archiveTagFilterExpanded = !archiveTagFilterExpanded;
    });
  });

  // Clear all timers
  $("#clear-all").addEventListener("click", () => {
    if (timers.length === 0) return;
    if (confirm("Are you sure you want to delete all timers?")) {
      ActiveActions.deleteAll();
    }
  });

  // Update remaining times & detect completion.
  // Reschedule via setTimeout so a slow tick doesn't queue up back-to-back runs like setInterval would.
  // The delay is computed dynamically: fire right after the soonest displayed-second boundary
  // among all active timers/trash rows, instead of polling at a fixed interval.
  function computeNextTickDelay(now) {
    let minDelay = null;

    for (const t of timers) {
      if (t.paused || t.notified) continue;
      const remaining = t.endAt - now;
      if (remaining <= 0) continue;
      const untilBoundary = remaining % 1000 || 1000;
      minDelay =
        minDelay === null ? untilBoundary : Math.min(minDelay, untilBoundary);
    }

    for (const t of trash) {
      const purgesIn = clamp0(TRASH_RETENTION_MS - (now - t.deletedAt));
      if (purgesIn <= 0) continue;
      const untilBoundary = purgesIn % 1000 || 1000;
      minDelay =
        minDelay === null ? untilBoundary : Math.min(minDelay, untilBoundary);
    }

    return (minDelay === null ? 1000 : minDelay) + 10; // +10ms margin against early firing
  }

  function scheduleTick() {
    setTimeout(tick, computeNextTickDelay(Date.now()));
  }

  function tick() {
    let changed = false;
    const now = Date.now();
    for (const t of timers) {
      if (!t.paused && !t.notified && now >= t.endAt) {
        t.notified = true;
        playBeep(3, 1000, 0.18, 0.08);
        changed = true;
      }
    }

    const purged = purgeExpiredTrashItems();

    if (changed || purged) {
      Storage.save();
      renderActive();
      renderTrash();
      scheduleTick();
      return;
    }

    // lightweight in-place update of the trash countdown
    const trashRows = [...trashListEl.children];
    trashRows.forEach((row) => {
      const id = Number(row.dataset.id);
      const t = trash.find((x) => x.id === id);
      if (!t) return;

      TrashRow.patch(row, t, now);
    });

    // lightweight in-place update
    const rows = [...listEl.children];
    rows.forEach((row) => {
      if (
        row.classList.contains("editing") ||
        row.classList.contains("snoozing")
      ) {
        return;
      }

      const id = Number(row.dataset.id);
      const t = timers.find((x) => x.id === id);
      if (!t) return;

      ActiveRow.patch(row, t, now);
    });

    scheduleTick();
  }

  if (purgeExpiredTrashItems()) {
    Storage.save();
  }
  renderActive();
  renderTrash();
  renderArchived();
  setupStickyFormShadow();
  scheduleTick();
})();
