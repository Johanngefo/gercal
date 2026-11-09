# GerCal

An Obsidian plugin that turns dates written in your notes into a monthly calendar. Write a date anywhere in a note, and it shows up in the calendar and gets highlighted in the editor.

## Features

- **Dates in notes become calendar entries.** Any date in the format `DD.MM.YYYY` or `DD.MM.YY` is picked up from all notes in your vault.
- **Status codes.** Add a letter in brackets right after the date to categorise it:

  | Syntax | Meaning | Color |
  | --- | --- | --- |
  | `02.02.2027(G)` | Birthday (repeats every year) | Pink |
  | `02.02.2027(T)` | Appointment | Dark green |
  | `02.02.2027(S)` | Status | Gray |
  | `02.02.2027(W)` | Important | Red |
  | `02.02.2027` | No status | Purple |

- **Time ranges.** Append a start and end time to show the duration: `02.02.2027(T) 15:00 - 16:00` or `02.02.2027 17:00 - 20:00`.
- **Full view.** When the calendar is opened in the main workspace (not in a sidebar), timed entries are shown as bars with time, duration and note name, sorted by start time. In a sidebar, entries are shown as compact dots.
- **Daily notes.** Notes named exactly like a date (`2027-02-02` or `02.02.2027`) are shown on that day in orange.
- **Add events from the calendar.** Click a day to enter a title, date, status and an optional time range. GerCal creates a note named `DD.MM. Title` with the date line (e.g. `02.02.2027(T) 15:00 - 16:00`) as its first line.
- **Highlighting.** Dates are highlighted in the editor and in reading view, colored by status.
- **Insert command.** The command *Datum mit Status einfügen* inserts today's date (or converts a selected date) with a status of your choice.
- **Click to open.** Click any entry in the calendar to open its note.

## Installation

1. Download `main.js`, `styles.css` and `manifest.json`.
2. Copy them to `<your vault>/.obsidian/plugins/gercal/`.
3. Restart Obsidian and enable **GerCal** under *Settings → Community plugins*.

Open the calendar via the ribbon icon or the command *Open GerCal*.

## Notes

- Regular dates only appear in their specific year. Birthdays (`G`) repeat every year.
- New event notes are created in the folder set under *Settings → Files and links → Default location for new notes*.
