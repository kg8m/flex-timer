# flex-timer

A flexible multi-timer web app with tags, timer modes, and archiving — built with ChatGPT and Claude.

## Usage

Just open `index.html` in your browser.

## Features

- **Multiple Timers**: Manage multiple timers simultaneously
- **Flexible Duration Input**: Supports various formats (`5:00`, `5`, `1h`, `30s`, `1:30:00`, `2d`, etc.)
- **Two Timer Modes**: Set a timer by duration ("5 minutes from now") or by a target clock time ("at 15:00"); each timer shows a badge (⏳/🕐) for its mode
- **Day-of-Week Restriction**: Restrict a target clock time timer to only fire on chosen days of the week
- **Skip to Next Day**: Skip a running "at time" timer’s next occurrence and roll it forward a day (honoring its day-of-week restriction) without deleting or recreating it
- **Snooze**: Once a timer is Done, push its end time forward by a chosen number of minutes without touching its original duration/target-time setting — a distinct "Snoozed" status and colored Ends At time make snoozed timers easy to spot
- **Tags**: Add `#tag` tokens to a timer’s title to tag it, then filter each list (Timers/Archive/Trash) down to timers with a given tag — or with no tags — via filter chips (with a "Show all tags" toggle when there are many)
- **Inline Editing**: Edit a timer’s title, tags, duration/time, and day-of-week restriction in place — for active and archived timers alike
- **Timer Controls**: Pause, resume, and restart individual timers (Pause is only available for duration-based timers)
- **Archive**: Move a timer out of the active list to reuse its same settings later without deleting it
- **Trash**: Deleted timers (including via "Delete All") are kept for 5 minutes and can be restored before they’re purged for good
- **Collapsible Lists**: Collapse the Timers, Archived, and Trash cards to save space
- **Responsive Layout**: Sticky add-timer form while scrolling, and a compact per-row "more actions" menu on narrow screens
- **Audio Notification**: Beeps when timers complete (using Web Audio API)
- **Persistent Storage**: Timers are automatically saved in browser localStorage

## Tech

- No dependencies (single HTML file)
- Vanilla JavaScript
- Web Audio API
