(() => {
  /*** State ***/

  /**
   * An active timer, in either "duration" or "time" mode.
   * @typedef {object} ActiveTimer
   * @property {number} id
   * @property {string} title
   * @property {string[]} tags
   * @property {"duration"|"time"} mode
   * @property {number} endAt - epoch ms this timer fires at.
   * @property {number} createdAt - epoch ms this run started (reset on Restart).
   * @property {boolean} notified - whether the completion beep has fired for this run.
   * @property {boolean} snoozed - whether endAt is currently a snooze re-fire time.
   * @property {boolean} paused
   * @property {number} [pausedAt] - epoch ms Pause was pressed; only set while paused.
   * @property {number} [remainingAtPause] - ms remaining when Pause was pressed.
   * @property {number} originalDuration - configured duration in ms; the "duration" mode target, and preserved across "time" mode for Restart.
   * @property {string} [targetTime] - "HH:MM" or "HH:MM:SS"; the "time" mode target.
   * @property {number[]} [daysOfWeek] - Date#getDay() values (0=Sunday) restricting a "time" mode timer; empty/undefined means every day.
   */

  /**
   * A deleted timer awaiting purge, or the equivalent Archive shape below —
   * both drop the live-run fields (endAt/notified/snoozed/paused/...) that
   * only make sense for an `ActiveTimer`, and add one timestamp of their
   * own.
   * @typedef {object} TrashTimer
   * @property {number} id
   * @property {string} title
   * @property {string[]} tags
   * @property {"duration"|"time"} mode
   * @property {number} originalDuration
   * @property {string} [targetTime]
   * @property {number[]} [daysOfWeek]
   * @property {number} deletedAt - epoch ms; purged once TRASH_RETENTION_MS elapses.
   */

  /**
   * @typedef {object} ArchivedTimer
   * @property {number} id
   * @property {string} title
   * @property {string[]} tags
   * @property {"duration"|"time"} mode
   * @property {number} originalDuration
   * @property {string} [targetTime]
   * @property {number[]} [daysOfWeek]
   * @property {number} archivedAt - epoch ms.
   */

  /** @type {ActiveTimer[]} */
  let timers = [];
  /** @type {TrashTimer[]} */
  let trash = [];
  /** @type {ArchivedTimer[]} */
  let archived = [];
  let seq = 1;

  const TRASH_RETENTION_MS = 5 * 60 * 1000;

  /*** LocalStorage ***/

  /**
   * Persists `{seq, timers, trash, archived}` to localStorage as one JSON
   * blob. `migrateLegacyStorage` is a `load()`-only internal step, not
   * exposed.
   */
  const Storage = (() => {
    const STORAGE_KEY = "flex-timer-data";
    // TODO: Rename migration from the simple-timer era. Safe to remove around 2027.
    const LEGACY_STORAGE_KEY = "simple-timer-data";

    /** One-time migration from the pre-rename `simple-timer-data` key. */
    function migrateLegacyStorage() {
      if (localStorage.getItem(STORAGE_KEY) !== null) return;
      const legacyData = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyData === null) return;
      localStorage.setItem(STORAGE_KEY, legacyData);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }

    return {
      /** Writes the current state to localStorage. */
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

      /** Reads persisted state into timers/trash/archived, migrating the legacy key first. */
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

  /** Tagged template: joins the strings/values back into a plain string (no escaping/sanitizing — just interpolation). */
  const html = (strings, ...values) => {
    return strings.reduce(
      (result, string) => `${result}${string}${values.shift() ?? ""}`,
      "",
    );
  };

  /**
   * @param {string} sel
   * @param {ParentNode} [el]
   * @returns {Element|null}
   */
  const $ = (sel, el = document) => el.querySelector(sel);

  /**
   * Zero-pads a non-negative integer to (at least) 2 digits.
   *
   * @param {number} n
   * @returns {string}
   */
  const fmt2 = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");

  /**
   * @param {number} ms
   * @returns {number} `ms`, or 0 if negative.
   */
  const clamp0 = (ms) => (ms < 0 ? 0 : ms);

  /**
   * Pull #tag tokens out of a title string instead of requiring a
   * separate tags field: any "#" followed by non-whitespace becomes a
   * tag (normalized like the old comma-separated input — trimmed,
   * lowercased, deduped, sorted alphabetically regardless of input
   * order) and is removed from the displayed title.
   *
   * @param {string} rawTitle
   * @returns {{title: string, tags: string[]}}
   */
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

  /**
   * Inverse of extractTagsFromTitle: reassemble the raw text a user
   * would type (title + trailing #tag tokens) so an edit form can be
   * seeded with something that round-trips back through it unchanged.
   *
   * @param {ActiveTimer|TrashTimer|ArchivedTimer} t
   * @returns {string}
   */
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
    /**
     * Formats a timestamp as a time-only (no date) string.
     *
     * @param {number} ts
     * @returns {string}
     */
    function toTime(ts) {
      return new Date(ts).toLocaleTimeString([], { hour12: false });
    }

    /**
     * @param {number} a
     * @param {number} b
     * @returns {boolean}
     */
    function isSameDay(a, b) {
      return new Date(a).toDateString() === new Date(b).toDateString();
    }

    /**
     * Date with weekday, for tooltips on cross-day "Ends At" times.
     *
     * @param {number} ts
     * @returns {string}
     */
    function toDateWithWeekday(ts) {
      return new Date(ts).toLocaleDateString([], {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
      });
    }

    /**
     * Short weekday names indexed like Date#getDay() (0=Sunday) — this
     * indexing is load-bearing (checkbox data-day values and
     * advanceToAllowedDay's day-of-week matching both key off it) and
     * must not change even though the UI displays/lists Monday first.
     *
     * @type {string[]}
     */
    const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    /**
     * Display order for the weekday toggle buttons and daysOfWeekLabel:
     * Monday first, Sunday last (still Date#getDay() values under the
     * hood, just reordered for presentation).
     *
     * @type {number[]}
     */
    const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

    /**
     * Comma-joined weekday names (Monday-first) for a "time" mode
     * timer's daysOfWeek restriction, or "" when unrestricted (fires
     * every day).
     *
     * @param {number[]} [daysOfWeek]
     * @returns {string}
     */
    function daysOfWeekLabel(daysOfWeek) {
      if (!daysOfWeek || !daysOfWeek.length) return "";
      const order = new Set(daysOfWeek);
      return WEEKDAY_DISPLAY_ORDER.filter((d) => order.has(d))
        .map((d) => WEEKDAY_LABELS[d])
        .join(", ");
    }

    /**
     * Push `target` forward in 24h steps until it lands on a day-of-week
     * present in `daysOfWeek` (0=Sunday..6=Saturday, matching
     * Date#getDay()). A no-op when daysOfWeek is empty/undefined, which
     * means "every day". Bounded to 7 iterations since some day within
     * a week is always allowed whenever daysOfWeek is non-empty.
     *
     * @param {number} target - epoch ms.
     * @param {number[]} [daysOfWeek]
     * @returns {number} epoch ms.
     */
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

    /**
     * Resolve "HH:MM" or "HH:MM:SS" to the next occurrence of that time
     * (today if it hasn't passed yet, otherwise tomorrow), further
     * restricted to daysOfWeek if given. Seconds are optional and
     * default to 0.
     *
     * @param {string} timeStr
     * @param {number} [now] - epoch ms.
     * @param {number[]} [daysOfWeek]
     * @returns {number|null} epoch ms, or null if `timeStr` doesn't parse.
     */
    function computeNextTimeBasedEndAt(timeStr, now = Date.now(), daysOfWeek) {
      const m = String(timeStr || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (!m) return null;

      const hh = Number(m[1]);
      const mm = Number(m[2]);
      const ss = m[3] ? Number(m[3]) : 0;
      const d = new Date(now);
      d.setHours(hh, mm, ss, 0);

      let target = d.getTime();
      if (target <= now) target += 24 * 60 * 60 * 1000;

      return advanceToAllowedDay(target, daysOfWeek);
    }

    return {
      toTime,
      isSameDay,
      toDateWithWeekday,
      WEEKDAY_LABELS,
      WEEKDAY_DISPLAY_ORDER,
      daysOfWeekLabel,
      computeNextTimeBasedEndAt,
    };
  })();

  // Elapsed-time-span concerns: parsing and formatting a duration
  // (milliseconds), for "duration" mode timers.
  const Duration = (() => {
    return {
      /**
       * Formats a millisecond duration as `HH:MM:SS`.
       *
       * @param {number} ms
       * @returns {string}
       */
      humanize(ms) {
        ms = Math.max(0, Math.round(ms));
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;

        return `${fmt2(h)}:${fmt2(m)}:${fmt2(s)}`;
      },

      /**
       * Parses a duration string in `mm:ss`, `h:mm:ss`, plain-minutes, or
       * short-unit (`1h`/`90s`/`500ms`/`2d`) form.
       *
       * @param {string} input
       * @returns {number} ms, or 0 if `input` doesn't parse.
       */
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

      /**
       * Snap a duration-based endAt to the second grid so its countdown
       * decrements in phase with other timers instead of drifting by
       * the sub-second remainder of Date.now() at creation/resume time.
       *
       * @param {number} ms - epoch ms.
       * @returns {number} epoch ms, rounded to the nearest second.
       */
      alignEndAtToSecond(ms) {
        return Math.round(ms / 1000) * 1000;
      },

      /**
       * Formats a millisecond duration as `1d 2h 3m 4s` (only non-zero
       * parts).
       *
       * @param {number} ms
       * @returns {string}
       */
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

      /**
       * Render a duration back into an editable "H:MM:SS" / "MM:SS"
       * string (rather than formatDurationLabel's "1h 5m" form) so it
       * round-trips exactly through parseDuration when an edit is
       * saved unchanged.
       *
       * @param {number} ms
       * @returns {string}
       */
      durationToEditableString(ms) {
        const totalSec = Math.round(Math.max(0, ms) / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;

        return h > 0 ? `${h}:${fmt2(m)}:${fmt2(s)}` : `${m}:${fmt2(s)}`;
      },
    };
  })();

  /**
   * Resolve the end time for (re)starting a timer, branching on its
   * mode — the one place duration-mode and time-mode logic meet, so it
   * isn't owned by either Duration or Clock.
   *
   * @param {ActiveTimer|TrashTimer|ArchivedTimer} t
   * @param {number} [now] - epoch ms.
   * @returns {number|null} epoch ms; null if `t.mode === "time"` and `t.targetTime` doesn't parse.
   */
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

  /**
   * The target time for "time" mode, or the configured duration for
   * "duration" mode — the plain configured value, with no day-of-week
   * restriction attached. Trailing ":00" seconds are hidden since
   * they're the common (omitted) case. Used for the "Set" column in
   * Archive/Trash, which has no room to spare for a day list on top of
   * it.
   *
   * @param {ActiveTimer|TrashTimer|ArchivedTimer} t
   * @returns {string}
   */
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

  /**
   * Fallback title for an untitled timer: formatTimerLabel(t), with a
   * day-of-week restriction prefixed (e.g. "Mon 10:00") since this is
   * the one place that restriction is visible without hovering the
   * mode badge's tooltip.
   *
   * @param {ActiveTimer|TrashTimer|ArchivedTimer} t
   * @returns {string}
   */
  function formatFallbackTitle(t) {
    const label = formatTimerLabel(t);
    const days = t.mode === "time" ? Clock.daysOfWeekLabel(t.daysOfWeek) : "";
    return days ? `${days} ${label}` : label;
  }

  /**
   * Shared line-icon set (stroke-based, 24x24 viewBox): inline SVGs for
   * row-action buttons, the compact status dot, and the Duration/Time
   * mode badge, so every glyph in the UI shares one stroke weight/color
   * model instead of mixing emoji drawn in unrelated styles. Color
   * comes from the CSS `color` of whatever wraps the icon (buttons
   * already carry accent/warn/danger/neutral colors;
   * .status.ok/.paused/.done/.snoozed too), so call sites never need to
   * pick a color themselves.
   */
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

    /**
     * @param {string} name - a key of STROKE_ICON_PATHS, or "circle"/"more-vertical".
     * @param {number} [size]
     * @returns {string}
     */
    function icon(name, size = 18) {
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
    }

    /**
     * Compact status glyph shown at narrow widths (kept visually
     * distinct from the Actions icons: a plain dot, not a shape like
     * play/pause). Color comes from the wrapping
     * .status.ok/.paused/.done/.snoozed class, so this doesn't need to
     * take the status text/branch on it — every status renders the
     * same plain dot.
     *
     * @returns {string}
     */
    function statusIcon() {
      return icon("circle", 14);
    }

    /**
     * Small badge indicating whether a timer was set by duration or by
     * a target clock time. Tooltip shows the concrete value (e.g. the
     * original duration, or the originally configured target time —
     * the latter matters once Snooze can push endAt past it) so it's
     * visible even when a title hides the fallback label.
     *
     * @param {ActiveTimer|TrashTimer|ArchivedTimer} t
     * @returns {string}
     */
    function modeBadge(t) {
      const isTime = t.mode === "time";
      const days = isTime ? Clock.daysOfWeekLabel(t.daysOfWeek) : "";
      const label = isTime
        ? `At time: ${formatTimerLabel(t)}${days ? ` — ${days}` : ""}`
        : `Duration: ${Duration.formatDurationLabel(t.originalDuration)}`;

      return html`
        <span class="mode-badge" data-tooltip="${label}" aria-label="${label}">
          ${isTime ? icon("clock", 14) : icon("hourglass", 14)}
        </span>
      `;
    }

    return { icon, statusIcon, modeBadge };
  })();

  // Hot-path aliases: icon() is called inline in row/form templates
  // dozens of times per render, and modeBadge() a handful of times —
  // Icons itself still owns the full API surface. statusIcon isn't
  // aliased: it has only two call sites, nothing surprising to explain.
  const icon = Icons.icon;
  const modeBadge = Icons.modeBadge;

  /*** Sound ***/

  /** @type {AudioContext|null} */
  let audioCtx = null;

  /**
   * Plays a short beep sequence via the Web Audio API.
   *
   * @param {number} [times] - number of beeps.
   * @param {number} [freq] - oscillator frequency in Hz.
   * @param {number} [duration] - each beep's length in seconds.
   * @param {number} [gap] - silence between beeps in seconds.
   */
  function playBeep(times = 3, freq = 1000, duration = 0.18, gap = 0.08) {
    try {
      if (!audioCtx) {
        audioCtx = new AudioContext();
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

  /**
   * @param {string} s
   * @returns {string}
   */
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

  /**
   * Small pill row rendered under a timer's title (empty string, i.e.
   * nothing rendered, when the timer has no tags). Each tag is
   * clickable to toggle it in that list's tag filter (see the click
   * handlers on listEl/trashListEl/archiveListEl below).
   *
   * @param {ActiveTimer|TrashTimer|ArchivedTimer} t
   * @returns {string}
   */
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
  /** @type {Set<string>} */
  let timersTagFilter = new Set();
  /** @type {Set<string>} */
  let archiveTagFilter = new Set();
  /** @type {Set<string>} */
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
  /** @type {number|null} */
  let editingId = null;
  /** @type {{title: string, value: string, daysOfWeek?: number[]}|null} */
  let editDraft = null;

  // snoozingId/snoozeDraft mirror editingId/editDraft above, but for
  // the inline "extend by" form shown on a Done timer.
  /** @type {number|null} */
  let snoozingId = null;
  /** @type {{value: string}|null} */
  let snoozeDraft = null;

  // Tag-filtering feature shared by the Timers/Trash/Archived lists:
  // which tags are offered as chips, whether an item matches the
  // current filter, toggling a tag/clearing the filter, and rendering
  // the chip bar itself.
  const TagFilter = (() => {
    /**
     * @param {(ActiveTimer|TrashTimer|ArchivedTimer)[]} items
     * @returns {string[]} every distinct tag among `items`, sorted.
     */
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

    /**
     * @param {ActiveTimer|TrashTimer|ArchivedTimer} t
     * @param {Set<string>} filterSet
     * @returns {boolean} whether `t` matches the filter (no filter selected counts as a match).
     */
    function matches(t, filterSet) {
      if (!filterSet.size) return true;
      const tags = t.tags || [];
      if (filterSet.has(NO_TAGS_FILTER) && !tags.length) return true;
      return tags.some((tag) => filterSet.has(tag));
    }

    /**
     * @param {Set<string>} filterSet
     * @param {string} tag
     */
    function toggle(filterSet, tag) {
      if (filterSet.has(tag)) {
        filterSet.delete(tag);
      } else {
        filterSet.add(tag);
      }
    }

    /**
     * Renders the tag chip bar for one list, offering every tag present
     * among that list's own items (not just the currently filtered
     * subset), so deselecting a tag doesn't remove it from the choices.
     * When there are enough tags to wrap past one row, the chip bar
     * starts collapsed to one row with a toggle to expand/collapse it
     * (tracked via `expanded`, owned by the caller) — otherwise a list
     * with many distinct tags eats a lot of vertical space before any
     * timers/trash/archive rows are visible.
     *
     * @param {Element} containerEl
     * @param {(ActiveTimer|TrashTimer|ArchivedTimer)[]} items
     * @param {Set<string>} filterSet
     * @param {boolean} expanded
     */
    function renderChips(containerEl, items, filterSet, expanded) {
      const tags = availableTags(items);
      const hasUntagged = items.some((t) => !t.tags || !t.tags.length);
      // Even with no tags left to offer as chips, keep rendering when a
      // filter is still active so "Clear filter" stays reachable —
      // otherwise emptying the list (e.g. by deleting the last item
      // with the filtered tag) strands the filter with no way to reset
      // it short of a reload.
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
                  class="tag-filter-chip${filterSet.has(tag) ? " active" : ""}"
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

      // Measured before the "collapsed" class (and its max-height) is
      // applied, so scrollHeight reflects the bar's natural, unclipped
      // height — comparable directly against the CSS's one-row cap.
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
          // Inserted as the *first* child (not appended) so every chip
          // after it in the DOM floats around it (see the
          // ".tag-filter-toggle" float rule in the <style>) — a float
          // only affects content that follows it, so it has to come
          // before the chips it's meant to make room for.
          chipsEl.insertAdjacentHTML("afterbegin", toggleHtml);
        } else {
          // Collapsed: rendered as a sibling and overlaid on top of
          // the one-row chip bar instead (see
          // ".tag-filter-chips.collapsed ~ .tag-filter-toggle" in the
          // <style>), so it visibly covers the tail end of the
          // truncated row rather than reserving room inside it.
          containerEl.insertAdjacentHTML("beforeend", toggleHtml);
        }
      }
    }

    /**
     * Handles a click anywhere in a tag filter chip bar (select/deselect
     * a tag, clear the filter, or expand/collapse the chip bar via
     * toggleExpanded).
     *
     * @param {MouseEvent} e
     * @param {Set<string>} filterSet
     * @param {() => void} rerender
     * @param {() => void} toggleExpanded
     */
    function handleClick(e, filterSet, rerender, toggleExpanded) {
      const button = e.target.closest("button");
      if (!button) return;

      if (button.classList.contains("tag-filter-toggle")) {
        toggleExpanded();
      } else if (button.classList.contains("tag-filter-clear")) {
        filterSet.clear();
      } else {
        toggle(filterSet, button.dataset.tag);
      }

      rerender();
    }

    /**
     * Renders a list's "no items" message, adding an inline "Clear
     * filter" button when a tag filter is why nothing is shown — so it
     * can be reset right there, without opening a possibly collapsed
     * chip bar (see renderChips()) just to reach the one inside it.
     *
     * @param {Element} el
     * @param {boolean} itemsExist - whether the list has any items at all, before filtering.
     * @param {string} matchText - shown when items exist but none match the filter.
     * @param {string} emptyText - shown when the list has no items at all.
     * @param {Set<string>} filterSet
     */
    function renderEmptyState(el, itemsExist, matchText, emptyText, filterSet) {
      const text = itemsExist ? matchText : emptyText;
      el.innerHTML = filterSet.size
        ? html`
            ${escapeHtml(text)}
            <button type="button" class="tag-filter-clear">Clear filter</button>
          `
        : escapeHtml(text);
    }

    return { matches, toggle, renderChips, handleClick, renderEmptyState };
  })();

  /**
   * Inline edit form shown in place of a row's normal content. Shared
   * by the Timers and Archived lists: both item shapes carry the same
   * title/tags/mode/originalDuration/targetTime/daysOfWeek fields.
   */
  const EditForm = (() => {
    /**
     * Named buildHtml, not html, so it doesn't shadow the outer html
     * template-tag helper used throughout its own body.
     *
     * @param {ActiveTimer|ArchivedTimer} t
     * @returns {string}
     */
    function buildHtml(t) {
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
    }

    /**
     * Apply an edit form's current input values to `t` (a timer or
     * archived item — both share the same fields). Returns false
     * (leaving the edit form open) if the value field failed to
     * parse. Archived items have no endAt/paused/notified, so those
     * updates are skipped via the `"endAt" in t` guard, letting active
     * timers and archived items share this one function.
     *
     * @param {Element} row
     * @param {ActiveTimer|ArchivedTimer} t
     * @returns {boolean} whether the edit was applied (false leaves the form open).
     */
    function apply(row, t) {
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
    }

    /** @param {ParentNode} containerEl */
    function focusTitle(containerEl) {
      const input = $(".editing .edit-title", containerEl);
      if (input) {
        input.focus();
        input.select();
      }
    }

    /**
     * Shared Enter-to-save / Escape-to-cancel handling for both lists'
     * edit forms. renderFn is whichever of
     * renderActive()/renderArchived() owns the row the event
     * originated in.
     *
     * @param {() => void} renderFn
     * @returns {(e: KeyboardEvent) => void}
     */
    function handleKeydown(renderFn) {
      return (e) => {
        if (!e.target.matches(".edit-title, .edit-value")) return;

        if (e.key === "Escape") {
          editingId = null;
          editDraft = null;
          renderFn();
        } else if (e.key === "Enter") {
          // Ignore the Enter that confirms an IME composition (e.g.
          // finalizing Japanese kanji conversion) — it must not also
          // submit the edit.
          if (e.isComposing) return;

          const row = e.target.closest(".timer");
          const id = Number(row?.dataset.id);
          const t =
            timers.find((x) => x.id === id) ||
            archived.find((x) => x.id === id);

          if (t && apply(row, t)) {
            Storage.save();
            renderFn();
          }
        }
      };
    }

    /**
     * Keep editDraft in sync with in-progress (unsaved) edits so a full
     * renderActive()/renderArchived() triggered by unrelated state
     * doesn't wipe them.
     *
     * @param {Event} e
     */
    function handleInput(e) {
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
    }

    return {
      html: buildHtml,
      apply,
      focusTitle,
      handleKeydown,
      handleInput,
    };
  })();

  /**
   * Inline "extend by" form shown in place of a Done timer's Ends
   * At/Remaining/Status/Controls — the title (unlike EditForm.html,
   * which replaces the whole row including the title) stays put. Only
   * offered for active timers, so unlike EditForm.html this doesn't
   * need to handle the archived-item shape.
   */
  const SnoozeForm = (() => {
    /**
     * Named buildHtml, not html, so it doesn't shadow the outer html
     * template-tag helper used throughout its own body. Takes no timer
     * argument (unlike EditForm.html/ActiveRow.html) — snoozeDraft
     * fully determines its content.
     *
     * @returns {string}
     */
    function buildHtml() {
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
    }

    /**
     * Signed counterpart to Duration.parseDuration() — strips a
     * leading "-" before delegating, then negates the result. Only
     * used for the still-counting-down branch of save() below, where
     * a negative amount shortens the run; the already-Done branch
     * always wants a positive "N minutes from now" and uses
     * Duration.parseDuration() directly, since that's also the
     * shared duration grammar used by timer creation and Edit (which
     * must stay positive-only).
     *
     * @param {string} input
     * @returns {number} ms, negative allowed; 0 if `input` doesn't parse.
     */
    function parseSignedDuration(input) {
      const s = String(input || "").trim();
      const negative = s.startsWith("-");
      const dur = Duration.parseDuration(negative ? s.slice(1) : s);
      return dur ? (negative ? -dur : dur) : 0;
    }

    /**
     * Apply a snooze form's current input value to `t`. Returns false
     * (leaving the form open) if the value doesn't parse. Same mm:ss /
     * minutes / 1h / 30s / 2d format as the Duration mode field, via
     * Duration.parseDuration() — plus an optional leading "-" while
     * still counting down (see parseSignedDuration above). Deliberately
     * doesn't touch originalDuration/targetTime, so a later Restart
     * still uses the timer's original setting rather than the snoozed
     * length.
     *
     * While the run is still counting down toward its own completion
     * (whether or not it's already mid-snooze), the input adjusts that
     * completion time by the given amount — the natural "extend/shorten
     * what I'm already looking at" mental model, regardless of whether
     * this run has ever completed before. Once it's actually Done, there
     * is no "current completion" left to adjust, so the input instead
     * sets a fresh one, N from now — the classic alarm-snooze behavior.
     * No clamping is done if a shorten pushes endAt into the past; the
     * next tick()/render naturally treats that as Done.
     *
     * @param {Element} row
     * @param {ActiveTimer} t
     * @returns {boolean} whether the snooze was applied (false leaves the form open).
     */
    function save(row, t) {
      const valueInput = $(".snooze-value", row);
      const now = Date.now();
      const stillCountingDown = t.endAt > now;
      const delta = stillCountingDown
        ? parseSignedDuration(valueInput.value)
        : Duration.parseDuration(valueInput.value);

      if (!delta) {
        alert(
          stillCountingDown
            ? "Enter an amount to add, or a negative amount to shorten (mm:ss or minutes)."
            : "Enter snooze duration as mm:ss or minutes (number).",
        );
        return false;
      }

      t.endAt = Duration.alignEndAtToSecond(
        stillCountingDown ? t.endAt + delta : now + delta,
      );
      t.notified = false;
      t.snoozed = true;

      snoozingId = null;
      snoozeDraft = null;
      return true;
    }

    /** @param {ParentNode} containerEl */
    function focusValue(containerEl) {
      const input = $(".snoozing .snooze-value", containerEl);
      if (input) {
        input.focus();
        input.select();
      }
    }

    /**
     * Enter-to-confirm / Escape-to-cancel for the snooze form. Only
     * active timers offer Snooze, so unlike EditForm.handleKeydown this
     * doesn't need a renderFn parameter — it always re-renders the
     * Timers list.
     *
     * @param {KeyboardEvent} e
     */
    function handleKeydown(e) {
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

        if (t && save(row, t)) {
          Storage.save();
          renderActive();
        }
      }
    }

    /**
     * Keep snoozeDraft in sync with in-progress (unsaved) input so a
     * full renderActive() triggered by unrelated state doesn't reset it
     * back to the default value.
     *
     * @param {Event} e
     */
    function handleInput(e) {
      if (snoozingId == null || !e.target.matches(".snooze-value")) {
        return;
      }

      const row = e.target.closest(".timer");
      if (!row || Number(row.dataset.id) !== snoozingId) return;

      snoozeDraft = { value: e.target.value };
    }

    return { html: buildHtml, save, focusValue, handleKeydown, handleInput };
  })();

  const timersTagFilterEl = $("#timers-tag-filter");

  /**
   * Builds and patches a single Active-timer row's markup. html() is
   * used by renderActive() for a full (re)build of a row; patch() is
   * used by tick()'s lightweight in-place update. Both go through the
   * same internal view model, so the two never drift out of sync with
   * each other the way two independently-written functions could.
   */
  const ActiveRow = (() => {
    /**
     * @typedef {object} ActiveRowViewModel
     * @property {number} remaining - ms remaining; may be negative before clamping.
     * @property {boolean} done
     * @property {boolean} canSnooze
     * @property {boolean} canRestart
     * @property {string} statusText
     * @property {string} statusClass
     * @property {boolean} crossDay - whether Ends At falls on a different day than today.
     * @property {boolean} paused
     * @property {"duration"|"time"} mode
     */

    /**
     * @param {ActiveTimer} t
     * @param {number} now - epoch ms.
     * @returns {ActiveRowViewModel}
     */
    function computeViewModel(t, now) {
      const remaining = t.paused ? t.remainingAtPause || 0 : t.endAt - now;
      const done = remaining <= 0 && !t.paused;

      // Offered any time the run isn't Paused (a paused run's endAt
      // isn't live — remaining is frozen in remainingAtPause instead,
      // so there's nothing for Snooze to adjust). See SnoozeForm.save
      // for what it does in each case: while still counting down
      // (Running or already mid-snooze) it adjusts the current
      // completion time by the entered amount, one-off, without
      // touching originalDuration/targetTime; once Done it sets a
      // fresh completion N from now, same as a classic alarm snooze.
      const canSnooze = !t.paused;

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

    /**
     * @typedef {object} ActionSpec
     * @property {string} act - the `data-act` value.
     * @property {string} tooltip
     * @property {string} icon - an `Icons.icon()` name.
     * @property {string} class
     */

    /**
     * Renders a single row-action button, or "" when spec is null (the
     * action doesn't apply to this timer). extraClass adds a
     * controls-row-only modifier (e.g. "wide-action") without affecting
     * the same action's row-menu-popover rendering.
     *
     * @param {ActionSpec|null} spec
     * @param {string} [extraClass]
     * @returns {string}
     */
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

    /**
     * Unlike restartButton/skipButton/snoozeButton below, this slot's
     * button isn't a single yes/no condition — it's exactly one of
     * four mutually exclusive states (Done/Paused/Time mode/default).
     *
     * @param {ActiveRowViewModel} vm
     * @returns {string}
     */
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

    /**
     * Called with no extraClass for the row-menu-popover's copy of
     * this action, and with "wide-action" for the controls-row copy —
     * same action, just a different layout modifier.
     *
     * @param {ActiveRowViewModel} vm
     * @param {string} [extraClass]
     * @returns {string}
     */
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

    /**
     * @param {ActiveRowViewModel} vm
     * @returns {string}
     */
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

    /**
     * Only reached when t.id !== snoozingId — see html() below, which
     * replaces .controls (and everything else after .title) with
     * SnoozeForm.html() once this row's own form is open, so there's
     * no redundant trigger sitting next to it. Like restartButton,
     * called with no extraClass for the row-menu-popover's copy.
     *
     * @param {ActiveRowViewModel} vm
     * @param {string} [extraClass]
     * @returns {string}
     */
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
      /**
       * @param {ActiveTimer} t
       * @param {number} now - epoch ms.
       * @returns {string}
       */
      html(t, now) {
        const vm = computeViewModel(t, now);

        // .when picks up a "snoozed" class from t.snoozed so a
        // snoozed run's Ends At time stays visually distinct even
        // after it reaches Done again — t.snoozed is only cleared by
        // Restart or Edit (see EditForm.apply), which define a
        // genuinely new run, deliberately not by tick()'s
        // natural-completion branch.
        const restOfRowHtml =
          t.id === snoozingId
            ? SnoozeForm.html()
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
                    ${Icons.statusIcon()}
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

      /**
       * @param {Element} row
       * @param {ActiveTimer} t
       * @param {number} now - epoch ms.
       */
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
          statusIconEl.innerHTML = Icons.statusIcon();
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

  /**
   * Captures which field (if any) inside `containerEl` currently has
   * focus, so a full rebuild (e.g. renderActive() below) can restore
   * it afterward instead of dropping focus out of the edit/snooze
   * form the moment an unrelated timer finishes mid-edit — the
   * rebuilt row is a brand-new DOM node even when editDraft/
   * snoozeDraft keep its *value* unchanged.
   *
   * @param {Element} containerEl
   * @returns {{id: string, selector: string, selectionStart: number|null, selectionEnd: number|null}|null}
   */
  function captureFocus(containerEl) {
    const active = document.activeElement;
    if (!active || !containerEl.contains(active)) return null;

    if (active.tagName !== "INPUT") return null;

    const row = active.closest(".timer");
    if (!row) return null;

    // Every EditForm/SnoozeForm text/time input carries exactly one
    // distinguishing class (.edit-title/.edit-value/.snooze-value),
    // which is enough to re-find it after a rebuild — so this needs
    // no per-field branch as more fields are added. The one exception
    // is the class-less weekday checkboxes, uniquely identified within
    // a row by data-day instead.
    const selector = active.classList.length
      ? `.${[...active.classList].join(".")}`
      : active.dataset.day != null
        ? `input[data-day="${active.dataset.day}"]`
        : null;
    if (!selector) return null;

    return {
      id: row.dataset.id,
      selector,
      selectionStart: "selectionStart" in active ? active.selectionStart : null,
      selectionEnd: "selectionEnd" in active ? active.selectionEnd : null,
    };
  }

  /**
   * Restores focus captured by captureFocus() above, once the rebuilt
   * row is back in the DOM.
   *
   * @param {Element} containerEl
   * @param {ReturnType<typeof captureFocus>} saved
   */
  function restoreFocus(containerEl, saved) {
    if (!saved) return;

    const row = containerEl.querySelector(`.timer[data-id="${saved.id}"]`);
    const el = row && row.querySelector(saved.selector);
    if (!el) return;

    el.focus();
    if (saved.selectionStart != null && "setSelectionRange" in el) {
      el.setSelectionRange(saved.selectionStart, saved.selectionEnd);
    }
  }

  /** Fully rebuilds the Active list (`#timers`) from `timers`. */
  function renderActive() {
    const savedFocus = captureFocus(listEl);

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
    TagFilter.renderEmptyState(
      timersEmptyEl,
      timers.length > 0,
      "No timers match the selected tags.",
      "No timers.",
      timersTagFilter,
    );
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

    restoreFocus(listEl, savedFocus);
  }

  const trashListEl = $("#trash-list");
  const trashEmptyEl = $("#trash-empty");
  const trashHeaderEl = $("#trash-header");
  const trashTagFilterEl = $("#trash-tag-filter");

  /**
   * Builds a single Trash row's markup, and patches its purge
   * countdown in tick()'s lightweight update — both share the same
   * purgesIn() so they can't drift apart.
   */
  const TrashRow = (() => {
    /**
     * @param {TrashTimer} t
     * @param {number} now - epoch ms.
     * @returns {number} ms until this item is purged.
     */
    function purgesIn(t, now) {
      return clamp0(TRASH_RETENTION_MS - (now - t.deletedAt));
    }

    return {
      /**
       * @param {TrashTimer} t
       * @param {number} now - epoch ms.
       * @returns {string}
       */
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

      /**
       * @param {Element} row
       * @param {TrashTimer} t
       * @param {number} now - epoch ms.
       */
      patch(row, t, now) {
        $(".remain", row).textContent = Duration.humanize(purgesIn(t, now));
      },
    };
  })();

  /** Fully rebuilds the Trash list (`#trash-list`) from `trash`. */
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
    TagFilter.renderEmptyState(
      trashEmptyEl,
      trash.length > 0,
      "No trashed timers match the selected tags.",
      "Trash is empty.",
      trashTagFilter,
    );
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

  /**
   * Appends `t` to `trash` as a new `TrashTimer`.
   *
   * @param {ActiveTimer} t
   */
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

  /**
   * Removes any `trash` items past `TRASH_RETENTION_MS`.
   *
   * @returns {boolean} whether anything was purged.
   */
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

  /**
   * Builds a single Archived row's markup. Archived rows have no live
   * countdown, so unlike ActiveRow/TrashRow there's no tick()-side
   * patch step — renderArchived() rebuilding on any structural change
   * is enough.
   */
  const ArchivedRow = {
    /**
     * @param {ArchivedTimer} t
     * @returns {string}
     */
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

  /** Fully rebuilds the Archived list (`#archive-list`) from `archived`. */
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
    TagFilter.renderEmptyState(
      archiveEmptyEl,
      archived.length > 0,
      "No archived timers match the selected tags.",
      "No archived timers.",
      archiveTagFilter,
    );
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

  /**
   * Appends `t` to `archived` as a new `ArchivedTimer`.
   *
   * @param {ActiveTimer} t
   */
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

  /**
   * Toggles the `.stuck` class (drop shadow + translucent background)
   * on the add-timer form once it sticks to the top of the viewport
   * while scrolling, via an IntersectionObserver watching a sentinel
   * element placed just above it.
   */
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

  /**
   * Read the checked days from a .weekday-toggle-row's checkboxes
   * within `container`, returning undefined (meaning "every day") when
   * none *or all* are checked — selecting every day is the same
   * restriction as selecting none, so it's normalized the same way
   * rather than showing as a (redundant) 7-day restriction elsewhere.
   * Shared by the add-timer form and the inline edit row, both of
   * which render one .weekday-toggle-row.
   *
   * @param {ParentNode} container
   * @returns {number[]|undefined}
   */
  function readDaysOfWeek(container) {
    const days = [
      ...container.querySelectorAll(
        '.weekday-toggle-row input[type="checkbox"]:checked',
      ),
    ].map((cb) => Number(cb.dataset.day));
    return days.length && days.length < 7 ? days : undefined;
  }

  /**
   * Set a .weekday-toggle-row's checkboxes within `container` to
   * reflect `daysOfWeek` (undefined/empty checks none, meaning "every
   * day").
   *
   * @param {ParentNode} container
   * @param {number[]} [daysOfWeek]
   */
  function setDaysOfWeekCheckboxes(container, daysOfWeek) {
    const set = new Set(daysOfWeek || []);
    container
      .querySelectorAll('.weekday-toggle-row input[type="checkbox"]')
      .forEach((cb) => {
        cb.checked = set.has(Number(cb.dataset.day));
      });
  }

  /**
   * Shows the Duration or At-time fields (and toggles their `required`
   * attributes) to match the currently-selected mode radio, then
   * refocuses the title field.
   */
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

  /**
   * Actions available on an Active-list row, dispatched by data-act
   * from the click handler below.
   */
  const ActiveActions = {
    /** @param {ActiveTimer} t */
    delete(t) {
      timers = timers.filter((x) => x.id !== t.id);
      moveToTrash(t);
      Storage.save();
      renderActive();
      renderTrash();
    },

    /** @param {ActiveTimer} t */
    archive(t) {
      timers = timers.filter((x) => x.id !== t.id);
      moveToArchive(t);
      Storage.save();
      renderActive();
      renderArchived();
    },

    /** @param {ActiveTimer} t */
    pause(t) {
      const now = Date.now();
      t.paused = true;
      t.pausedAt = now;
      t.remainingAtPause = t.endAt - now;
      Storage.save();
      renderActive();
    },

    /** @param {ActiveTimer} t */
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

    /** @param {ActiveTimer} t */
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

    /**
     * While snoozed, t.endAt holds the snooze re-fire time rather than
     * an on-schedule target-time instant, so re-deriving from
     * t.targetTime (anchored to t.endAt's calendar day) rather than
     * just adding 24h keeps the skip aligned to the actual target time
     * even mid-snooze.
     *
     * @param {ActiveTimer} t
     */
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

    /** @param {number} id */
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

    /**
     * @param {Element} row
     * @param {ActiveTimer} t
     */
    saveEdit(row, t) {
      if (EditForm.apply(row, t)) {
        Storage.save();
        renderActive();
      }
    },

    /** @param {number} id */
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

    /**
     * @param {Element} row
     * @param {ActiveTimer} t
     */
    confirmSnooze(row, t) {
      if (SnoozeForm.save(row, t)) {
        Storage.save();
        renderActive();
      }
    },

    /** @param {Element} button */
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

  /**
   * Rebuilds a fresh Active timer entry from a Trash or Archived item
   * — shared by restoreFromTrash and restartFromArchive, which
   * otherwise duplicate this exact object shape.
   *
   * @param {TrashTimer | ArchivedTimer} t
   * @param {number} now
   * @returns {ActiveTimer}
   */
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

  /**
   * Actions available on a Trash-list row, dispatched by data-act
   * from the click handler below.
   */
  const TrashActions = {
    /** @param {TrashTimer} t */
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

  /**
   * Actions available on an Archived-list row, dispatched by
   * data-act from the click handler below.
   */
  const ArchiveActions = {
    /** @param {ArchivedTimer} t */
    restart(t) {
      archived = archived.filter((x) => x.id !== t.id);
      timers.push(reviveTimer(t, Date.now()));
      Storage.save();
      renderActive();
      renderArchived();
    },

    /** @param {ArchivedTimer} t */
    delete(t) {
      archived = archived.filter((x) => x.id !== t.id);
      moveToTrash(t);
      Storage.save();
      renderArchived();
      renderTrash();
    },

    /** @param {number} id */
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

    /**
     * @param {Element} row
     * @param {ArchivedTimer} t
     */
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

  // Each list's empty-state message only ever contains a "Clear
  // filter" button (never the chip bar's expand/collapse toggle), but
  // handleClick() is shared with the chip bar listeners above, so it
  // still needs a toggleExpanded callback to satisfy that signature.
  timersEmptyEl.addEventListener("click", (e) => {
    TagFilter.handleClick(e, timersTagFilter, renderActive, () => {
      timersTagFilterExpanded = !timersTagFilterExpanded;
    });
  });
  trashEmptyEl.addEventListener("click", (e) => {
    TagFilter.handleClick(e, trashTagFilter, renderTrash, () => {
      trashTagFilterExpanded = !trashTagFilterExpanded;
    });
  });
  archiveEmptyEl.addEventListener("click", (e) => {
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

  /**
   * Delay in ms until the next tick should run: just past the soonest
   * displayed-second boundary among all active timers/trash rows,
   * instead of polling at a fixed interval.
   *
   * @param {number} now
   * @returns {number}
   */
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

  /**
   * Reschedules `tick` via `setTimeout` so a slow tick can't queue up
   * back-to-back runs the way `setInterval` would.
   */
  function scheduleTick() {
    setTimeout(tick, computeNextTickDelay(Date.now()));
  }

  /**
   * Updates remaining times and detects completion for the current
   * tick, then reschedules the next one via `scheduleTick`.
   */
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
